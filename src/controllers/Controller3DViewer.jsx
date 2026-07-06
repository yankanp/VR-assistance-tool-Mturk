import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buttonImageByName, normalizeButtonName } from '../common/buttonAssets';
import './Controller3DViewer.css';

// anchor is a point in the model GROUP's local space; each frame it is
// transformed to world and projected to screen, so it is rigidly tied to the
// model and rotates with it. These values were measured directly from the GLB
// geometry (per-button vertex clusters in the skin), so each dot sits on its
// own button. They are independent of the view angle.
const calloutsBySide = {
  left: [
    { id: 'joystick', label: 'Joystick', anchor: [0.074, 0.244, 0.176],  labelPos: [0.11, 0.15] },
    { id: 'x',        label: 'X',        anchor: [-0.093, 0.099, -0.120], labelPos: [0.89, 0.55] },
    { id: 'y',        label: 'Y',        anchor: [-0.283, 0.089, 0.100],  labelPos: [0.89, 0.16] },
    { id: 'trigger',  label: 'Trigger',  anchor: [-0.250, -0.265, -0.105], labelPos: [0.22, 0.48] },
    { id: 'grip',     label: 'Grip',     anchor: [-0.165, -0.440, -0.400], labelPos: [0.58, 0.72] },
  ],
  right: [
    { id: 'joystick', label: 'Joystick', anchor: [-0.125, 0.215, 0.168],  labelPos: [0.9, 0.15] },
    { id: 'a',        label: 'A',        anchor: [0.073, 0.116, -0.129],   labelPos: [0.1, 0.55] },
    { id: 'b',        label: 'B',        anchor: [0.259, 0.153, 0.092],    labelPos: [0.08, 0.15] },
    { id: 'trigger',  label: 'Trigger',  anchor: [0.160, -0.165, 0.405],  labelPos: [0.88, 0.48] },
    { id: 'grip',     label: 'Grip',     anchor: [0.25, -0.440, -0.400],  labelPos: [0.42, 0.72] },
  ],
};

const baseRotationBySide = {
  left: [0.72, 2.74, 0],
  right: [0.72, 3.54, 0],
};

const focusPoseBySide = {
  left: {
    joystick: { rotation: [1.22, 2.52, 0.32], cameraZ: 1.72 },
    x: { rotation: [0.12, 2.72, 0.02], cameraZ: 2.12 },
    y: { rotation: [0.12, 2.72, 0.02], cameraZ: 2.12 },
    trigger: { rotation: [0.18, -0.02, -0.2], cameraZ: 1.95 },
    grip: { rotation: [-0.42, 2.24, 0.02], cameraZ: 1.98 },
  },
  right: {
    joystick: { rotation: [0.72, 3.56, -0.52], cameraZ: 1.52 },
    a: { rotation: [0.12, 3.56, -0.02], cameraZ: 2.12 },
    b: { rotation: [0.12, 3.56, -0.02], cameraZ: 2.12 },
    trigger: { rotation: [-0.28, -0.26, 0.8], cameraZ: 2.15 },
    grip: { rotation: [-0.42, 4.02, -0.22], cameraZ: 2.18 },
  },
};

export default function Controller3DViewer({
  side,
  modelPath,
  requiredButtons = [],
  calibrate = false,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const modelRef = useRef(null);
  const calibrateRef = useRef(calibrate);
  const focusAnimationRef = useRef(null);
  const [points, setPoints] = useState([]);

  const normalizedSide = side.toLowerCase();
  const requiredButtonsKey = useMemo(
    () => [...new Set(requiredButtons.map(normalizeButtonName).filter(Boolean))].sort().join('|'),
    [requiredButtons],
  );
  const callouts = useMemo(
    () => {
      const requiredButtonIds = new Set(requiredButtonsKey.split('|').filter(Boolean));
      return (calloutsBySide[normalizedSide] ?? calloutsBySide.left)
        .filter((callout) => requiredButtonIds.has(callout.id));
    },
    [normalizedSide, requiredButtonsKey],
  );

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
    camera.position.set(0, 0.05, 3.05);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rendererRef.current = renderer;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x313543, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);

    const modelGroup = new THREE.Group();
    modelGroup.rotation.set(...(baseRotationBySide[normalizedSide] ?? baseRotationBySide.left));
    modelGroup.position.y = 0.68;
    scene.add(modelGroup);
    modelRef.current = modelGroup;

    const startQuaternion = modelGroup.quaternion.clone();
    const targetQuaternion = startQuaternion.clone();
    const startPosition = modelGroup.position.clone();
    const targetPosition = startPosition.clone();
    let targetCameraZ = camera.position.z;

    if (callouts.length > 0) {
      const focusAnchor = callouts.reduce(
        (sum, callout) => sum.add(new THREE.Vector3().fromArray(callout.anchor)),
        new THREE.Vector3(),
      ).multiplyScalar(1 / callouts.length);
      const firstFocusPose = focusPoseBySide[normalizedSide]?.[callouts[0].id];
      if (callouts.length === 1 && firstFocusPose) {
        targetQuaternion.setFromEuler(new THREE.Euler(...firstFocusPose.rotation));
        targetCameraZ = firstFocusPose.cameraZ;
      } else {
        const topFacePose = focusPoseBySide[normalizedSide]?.joystick;
        if (topFacePose) {
          targetQuaternion.setFromEuler(new THREE.Euler(...topFacePose.rotation));
          targetCameraZ = 2.2;
        }
      }

      const focusedAnchor = focusAnchor.clone().applyQuaternion(targetQuaternion);
      targetPosition.set(-focusedAnchor.x, 0.24 - focusedAnchor.y, 0);
    }

    focusAnimationRef.current = {
      active: callouts.length > 0,
      startedAt: null,
      duration: 650,
      startQuaternion,
      targetQuaternion,
      startPosition,
      targetPosition,
      startCameraZ: camera.position.z,
      targetCameraZ,
    };

    let disposed = false;
    const loader = new GLTFLoader();
    loader.load(
      modelPath,
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const largestSide = Math.max(size.x, size.y, size.z) || 1;

        root.position.sub(center);
        root.scale.setScalar(1.45 / largestSide);
        modelGroup.add(root);
      },
      undefined,
      () => {
        setPoints([]);
      },
    );

    function resize() {
      const rect = container.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const worldPoint = new THREE.Vector3();
    const localAnchorPoint = new THREE.Vector3();
    const projectedPoint = new THREE.Vector3();

    function render(frameTime = performance.now()) {
      if (disposed) return;

      const focusAnimation = focusAnimationRef.current;
      if (focusAnimation?.active) {
        if (focusAnimation.startedAt == null) focusAnimation.startedAt = frameTime;
        const progress = Math.min(
          1,
          (frameTime - focusAnimation.startedAt) / focusAnimation.duration,
        );
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        modelGroup.quaternion.slerpQuaternions(
          focusAnimation.startQuaternion,
          focusAnimation.targetQuaternion,
          easedProgress,
        );
        modelGroup.position.lerpVectors(
          focusAnimation.startPosition,
          focusAnimation.targetPosition,
          easedProgress,
        );
        camera.position.z = THREE.MathUtils.lerp(
          focusAnimation.startCameraZ,
          focusAnimation.targetCameraZ,
          easedProgress,
        );
        if (progress >= 1) focusAnimation.active = false;
      }

      renderer.render(scene, camera);

      const rect = container.getBoundingClientRect();
      const nextPoints = callouts.map((callout) => {
        localAnchorPoint.fromArray(callout.anchor);
        worldPoint.copy(localAnchorPoint);
        modelGroup.localToWorld(worldPoint);
        projectedPoint.copy(worldPoint).project(camera);
        const visible = projectedPoint.z >= -1 &&
          projectedPoint.z <= 1;
        return {
          ...callout,
          visible,
          x: (projectedPoint.x * 0.5 + 0.5) * rect.width,
          y: (-projectedPoint.y * 0.5 + 0.5) * rect.height,
          labelX: callout.labelPos[0] * rect.width,
          labelY: callout.labelPos[1] * rect.height,
        };
      });
      setPoints(nextPoints);
      requestAnimationFrame(render);
    }

    render();

    // Optional fine-tune: press "c", click a button, copy the logged anchor.
    const calibrateRaycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onKeyDown(e) {
      if (e.key === 'c' || e.key === 'C') {
        calibrateRef.current = !calibrateRef.current;
        console.log('[Controller3DViewer] calibrate:', calibrateRef.current);
      }
    }
    function onCanvasClick(event) {
      if (!calibrateRef.current) return;
      const rect = container.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      calibrateRaycaster.setFromCamera(pointer, camera);
      const hits = calibrateRaycaster.intersectObject(modelGroup, true);
      if (!hits.length) return;
      const local = modelGroup.worldToLocal(hits[0].point.clone());
      console.log(`anchor: [${+local.x.toFixed(3)}, ${+local.y.toFixed(3)}, ${+local.z.toFixed(3)}]`);
    }
    window.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('click', onCanvasClick);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('click', onCanvasClick);
      resizeObserver.disconnect();
      focusAnimationRef.current = null;
      renderer.dispose();
    };
  }, [callouts, modelPath, normalizedSide]);

  return (
    <div
      ref={containerRef}
      className="controller-3d-viewer"
    >
      <canvas ref={canvasRef} className="controller-3d-canvas" />
      <svg className="controller-callout-lines" aria-hidden="true">
        {points.filter((point) => point.visible).map((point) => (
          <line
            key={`${point.id}-line`}
            x1={point.labelX}
            y1={point.labelY}
            x2={point.x}
            y2={point.y}
          />
        ))}
        {points.filter((point) => point.visible).map((point) => (
          <circle
            className="controller-button-border"
            key={`${point.id}-border`}
            cx={point.x}
            cy={point.y}
            r="9"
          />
        ))}
        {points.filter((point) => point.visible).map((point) => (
          <circle
            className="controller-callout-dot"
            key={`${point.id}-dot`}
            cx={point.x}
            cy={point.y}
            r="3.5"
          />
        ))}
      </svg>
      {points.filter((point) => point.visible).map((point) => {
        const icon = buttonImageByName[normalizeButtonName(point.id)];
        return (
          <div
            className="controller-callout"
            key={point.id}
            style={{ left: point.labelX, top: point.labelY }}
          >
            {icon && <img src={icon} alt="" />}
            <span >{point.label}</span>
          </div>
        );
      })}
    </div>
  );
}

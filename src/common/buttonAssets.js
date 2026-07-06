export const buttonImageByName = {
  a: 'img/A.png',
  b: 'img/B.png',
  grip: 'img/Grip.png',
  joystick: 'img/joystick.png',
  thumbstick: 'img/joystick.png',
  trigger: 'img/Trigger.png',
  x: 'img/X.png',
  y: 'img/Y.png',
};

export function normalizeButtonName(button) {
  const normalized = button?.toLowerCase();
  return normalized === 'thumbstick' ? 'joystick' : normalized;
}

export function formatButtons(buttons = []) {
  return buttons.length
    ? buttons.map((button) => {
        const normalized = normalizeButtonName(button);
        return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : button;
      }).join(', ')
    : 'None';
}

export function getButtonImages(buttons = []) {
  return buttons
    .map((button) => buttonImageByName[normalizeButtonName(button)])
    .filter(Boolean)
    .slice(0, 3);
}

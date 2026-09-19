export const HANDS = {
  rock: {
    id: "rock",
    key: "1",
    label: "石頭",
    emoji: "✊",
    color: "#ff4d6d",
    glow: "rgba(255, 77, 109, 0.55)",
  },
  scissors: {
    id: "scissors",
    key: "2",
    label: "剪刀",
    emoji: "✌️",
    color: "#3df0ff",
    glow: "rgba(61, 240, 255, 0.5)",
  },
  paper: {
    id: "paper",
    key: "3",
    label: "布",
    emoji: "✋",
    color: "#ffe14a",
    glow: "rgba(255, 225, 74, 0.5)",
  },
};

export const HAND_ORDER = ["rock", "scissors", "paper"];

export function handByKey(key) {
  return HAND_ORDER.map((id) => HANDS[id]).find((hand) => hand.key === key) || null;
}

export function handMarkup(id, { giant = false } = {}) {
  const hand = HANDS[id];
  if (!hand) return "";
  return `
    <div class="hand-figure ${giant ? "is-giant" : ""}" style="--hand:${hand.color}; --glow:${hand.glow}">
      <div class="hand-emoji">${hand.emoji}</div>
      <div class="hand-kana">${hand.label}</div>
    </div>
  `;
}

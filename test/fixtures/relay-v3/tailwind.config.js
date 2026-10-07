/** A classic Tailwind v3 config, in the CommonJS shape v3 configs are written in. */

module.exports = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "var(--relay-ink)",
        paper: "var(--relay-paper)",
        // A scale entry can be a literal, and a nested one carries a DEFAULT.
        brand: { DEFAULT: "#0b7285", muted: "var(--relay-body-bg)" },
      },
      borderRadius: {
        card: "6px",
        pill: "var(--relay-radius-pill)",
      },
      boxShadow: {
        // Relay ships no effect tokens, so this entry resolves to nothing and
        // is dropped rather than inventing a shadow the system does not have.
        card: "0 1px 2px rgba(0, 0, 0, 0.08)",
      },
    },
  },
}

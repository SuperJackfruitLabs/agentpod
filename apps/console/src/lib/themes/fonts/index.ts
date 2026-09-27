/**
 * Font Pairings Collection
 * 
 * Curated font combinations that work well together.
 * Each pairing defines body, heading, and monospace fonts.
 * 
 * All fonts are bundled locally in /static/fonts/
 */

import type { FontPairing } from "../presets/types";

// Re-export type
export type { FontPairing } from "../presets/types";

// =============================================================================
// Classic Pairings - Timeless, professional choices
// =============================================================================

export const classicInter: FontPairing = {
  id: "classic-inter",
  label: "Inter",
  category: "classic",
  description: "Clean and highly readable system-like font",
  fonts: {
    "font-body": "Inter",
    "font-heading": "Inter",
    "font-mono": "JetBrains Mono",
  },
};

export const musterArchivo: FontPairing = {
  id: "muster-archivo",
  label: "Archivo · IBM Plex Mono",
  category: "classic",
  description: "The console's own pairing: a signage grotesk with an institutional mono.",
  fonts: {
    "font-body": "Archivo",
    "font-heading": "Archivo",
    "font-mono": "IBM Plex Mono",
  },
};

export const classicNunito: FontPairing = {
  id: "classic-nunito",
  label: "Nunito",
  category: "classic",
  description: "Friendly and rounded for comfortable reading",
  fonts: {
    "font-body": "Nunito",
    "font-heading": "Nunito",
    "font-mono": "JetBrains Mono",
  },
};

// =============================================================================
// Modern Pairings - Contemporary, geometric designs
// =============================================================================

export const modernGeometric: FontPairing = {
  id: "modern-geometric",
  label: "Space Grotesk",
  category: "modern",
  description: "Geometric sans-serif with personality",
  fonts: {
    "font-body": "Space Grotesk",
    "font-heading": "Space Grotesk",
    "font-mono": "JetBrains Mono",
  },
};

export const modernDM: FontPairing = {
  id: "modern-dm",
  label: "DM Sans",
  category: "modern",
  description: "Low-contrast geometric sans for modern UIs",
  fonts: {
    "font-body": "DM Sans",
    "font-heading": "DM Sans",
    "font-mono": "JetBrains Mono",
  },
};

export const modernPoppins: FontPairing = {
  id: "modern-poppins",
  label: "Nunito + Poppins",
  category: "modern",
  description: "Geometric headings with friendly body text",
  fonts: {
    "font-body": "Nunito",
    "font-heading": "Poppins",
    "font-mono": "JetBrains Mono",
  },
};

// =============================================================================
// Technical Pairings - Developer-focused combinations
// =============================================================================

export const techIBM: FontPairing = {
  id: "tech-ibm",
  label: "IBM Plex",
  category: "technical",
  description: "IBM's open-source typeface family",
  fonts: {
    "font-body": "IBM Plex Sans",
    "font-heading": "IBM Plex Sans",
    "font-mono": "IBM Plex Mono",
  },
};

export const techSource: FontPairing = {
  id: "tech-source",
  label: "Source Sans + Source Code",
  category: "technical",
  description: "Adobe's open-source type family",
  fonts: {
    "font-body": "Source Sans 3",
    "font-heading": "Source Sans 3",
    "font-mono": "Source Code Pro",
  },
};

export const techFira: FontPairing = {
  id: "tech-fira",
  label: "Inter + Fira Code",
  category: "technical",
  description: "Clean UI with ligature-rich code font",
  fonts: {
    "font-body": "Inter",
    "font-heading": "Inter",
    "font-mono": "Fira Code",
  },
};

// =============================================================================
// Editorial Pairings - Elegant, serif-based combinations
// =============================================================================

export const editorialClassic: FontPairing = {
  id: "editorial-classic",
  label: "Lora + Playfair",
  category: "editorial",
  description: "Elegant serif pairing for editorial content",
  fonts: {
    "font-body": "Lora",
    "font-heading": "Playfair Display",
    "font-mono": "JetBrains Mono",
  },
};

export const editorialLuxury: FontPairing = {
  id: "editorial-luxury",
  label: "Cormorant Garamond",
  category: "editorial",
  description: "Sophisticated display serif with French elegance",
  fonts: {
    "font-body": "Cormorant Garamond",
    "font-heading": "Cormorant Garamond",
    "font-mono": "JetBrains Mono",
  },
};

export const editorialNature: FontPairing = {
  id: "editorial-nature",
  label: "Source Sans + Playfair",
  category: "editorial",
  description: "Sans body with elegant serif headings",
  fonts: {
    "font-body": "Source Sans 3",
    "font-heading": "Playfair Display",
    "font-mono": "Source Code Pro",
  },
};

// =============================================================================
// Creative Pairings - Distinctive, expressive choices
// =============================================================================

export const creativeCyberpunk: FontPairing = {
  id: "creative-cyberpunk",
  label: "Rajdhani + Orbitron",
  category: "creative",
  description: "Futuristic sci-fi aesthetic",
  fonts: {
    "font-body": "Rajdhani",
    "font-heading": "Orbitron",
    "font-mono": "JetBrains Mono",
  },
};

export const creativeCosmicNight: FontPairing = {
  id: "creative-cosmic",
  label: "Exo 2 + Orbitron",
  category: "creative",
  description: "Space-age typography for cosmic themes",
  fonts: {
    "font-body": "Exo 2",
    "font-heading": "Orbitron",
    "font-mono": "Fira Code",
  },
};

export const creativeRetro: FontPairing = {
  id: "creative-retro",
  label: "Press Start 2P",
  category: "creative",
  description: "8-bit pixel font for retro gaming aesthetic",
  fonts: {
    "font-body": "Press Start 2P",
    "font-heading": "Press Start 2P",
    "font-mono": "JetBrains Mono",
  },
};

export const creativeRoseGold: FontPairing = {
  id: "creative-rose",
  label: "Nunito + Quicksand",
  category: "creative",
  description: "Soft, rounded fonts for elegant themes",
  fonts: {
    "font-body": "Nunito",
    "font-heading": "Quicksand",
    "font-mono": "Fira Code",
  },
};

export const creativeOcean: FontPairing = {
  id: "creative-ocean",
  label: "Source Sans + Raleway",
  category: "creative",
  description: "Elegant thin weights for airy designs",
  fonts: {
    "font-body": "Source Sans 3",
    "font-heading": "Raleway",
    "font-mono": "Source Code Pro",
  },
};

// =============================================================================
// Exports
// =============================================================================

export const fontPairings: FontPairing[] = [
  // Classic
  musterArchivo,
  classicInter,
  classicNunito,
  // Modern
  modernGeometric,
  modernDM,
  modernPoppins,
  // Technical
  techIBM,
  techSource,
  techFira,
  // Editorial
  editorialClassic,
  editorialLuxury,
  editorialNature,
  // Creative
  creativeCyberpunk,
  creativeCosmicNight,
  creativeRetro,
  creativeRoseGold,
  creativeOcean,
];

export const fontPairingsMap = new Map<string, FontPairing>(
  fontPairings.map((fp) => [fp.id, fp])
);

export function getFontPairingsByCategory(category: FontPairing["category"]): FontPairing[] {
  return fontPairings.filter((fp) => fp.category === category);
}

// Default font pairing — the console's own, not a borrowed classic
export const DEFAULT_FONT_PAIRING_ID = "muster-archivo";

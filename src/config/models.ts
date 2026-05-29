import { PRICING, type Pricing } from "./pricing.js";

export type Axis = "temporal" | "tier";
export type Family = "haiku" | "sonnet" | "opus";

export interface ModelEntry {
  id: string;
  displayName: string;
  shortName: string;
  family: Family;
  generation: number;
  releaseDate: string;
  axes: Axis[];
  tier: Family | null;
  pricing: Pricing;
  /** Some newer models (e.g. Opus 4.7) deprecate the `temperature` parameter. */
  supportsTemperature: boolean;
}

export const MODELS: readonly ModelEntry[] = [
  {
    id: "claude-sonnet-4-20250514",
    displayName: "Sonnet 4 (May 2025)",
    shortName: "S4",
    family: "sonnet",
    generation: 4.0,
    releaseDate: "2025-05-14",
    axes: ["temporal"],
    tier: null,
    pricing: PRICING["claude-sonnet-4-20250514"]!,
    supportsTemperature: true,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    displayName: "Sonnet 4.5 (Sep 2025)",
    shortName: "S4.5",
    family: "sonnet",
    generation: 4.5,
    releaseDate: "2025-09-29",
    axes: ["temporal"],
    tier: null,
    pricing: PRICING["claude-sonnet-4-5-20250929"]!,
    supportsTemperature: true,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    shortName: "S4.6",
    family: "sonnet",
    generation: 4.6,
    releaseDate: "2025-11-01",
    axes: ["temporal", "tier"],
    tier: "sonnet",
    pricing: PRICING["claude-sonnet-4-6"]!,
    supportsTemperature: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    shortName: "H4.5",
    family: "haiku",
    generation: 4.5,
    releaseDate: "2025-10-01",
    axes: ["tier"],
    tier: "haiku",
    pricing: PRICING["claude-haiku-4-5-20251001"]!,
    supportsTemperature: true,
  },
  {
    id: "claude-opus-4-7",
    displayName: "Opus 4.7",
    shortName: "O4.7",
    family: "opus",
    generation: 4.7,
    releaseDate: "2026-01-15",
    axes: ["tier"],
    tier: "opus",
    pricing: PRICING["claude-opus-4-7"]!,
    supportsTemperature: false,
  },
];

export function modelById(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelsOnAxis(axis: Axis): ModelEntry[] {
  return MODELS.filter((m) => m.axes.includes(axis));
}

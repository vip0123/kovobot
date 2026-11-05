// The Plans-and-prices constant: launch numbers from docs/design.md (Plans,
// Prices, Payments, Computers). Change them there first, then here; the
// server, the clients and the landing page all read this. Money is in US cents.

export type PlanId = "free" | "pro" | "max";
export type ComputerSize = "small" | "medium" | "large" | "xl";

export interface Plan {
  id: PlanId;
  name: string;
  /** The monthly Subscription payment; 0 for Free. */
  monthlyPriceCents: number;
  /** Plan credit each paid month. */
  planCreditCents: number;
  /** The Lifetime paid that unlocks this Plan. */
  unlockedAtCents: number;
  /** Bots a Customer may have; null means unlimited. */
  bots: number | null;
  /** Linux Computers, running or Asleep. */
  linuxComputers: number;
  /** Linux Computer hours a month; null means no cap. */
  linuxHoursPerMonth: number | null;
  computerSizes: readonly ComputerSize[];
  windows: boolean;
  macos: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    monthlyPriceCents: 0,
    planCreditCents: 0,
    unlockedAtCents: 0,
    bots: null,
    linuxComputers: 1,
    linuxHoursPerMonth: 10,
    computerSizes: ["small", "medium"],
    windows: false,
    macos: false,
  },
  {
    id: "pro",
    name: "Pro",
    monthlyPriceCents: 2000,
    planCreditCents: 2000,
    unlockedAtCents: 2000,
    bots: null,
    linuxComputers: 2,
    linuxHoursPerMonth: null,
    computerSizes: ["small", "medium", "large"],
    windows: true,
    macos: false,
  },
  {
    id: "max",
    name: "Max",
    monthlyPriceCents: 20000,
    planCreditCents: 20000,
    unlockedAtCents: 20000,
    bots: null,
    linuxComputers: 5,
    linuxHoursPerMonth: null,
    computerSizes: ["small", "medium", "large", "xl"],
    windows: true,
    macos: true,
  },
];

/** Starter credit: given once, on Free, after a Starter payment and a verified phone number. */
export const STARTER_CREDIT = { creditCents: 500, starterPaymentCents: 100 } as const;

/** The Fee on AI use paid from Top-up credit. */
export const FEE_PERCENT = 5;

export const TOP_UP = {
  minCents: 500,
  maxCents: 100_000,
  presetCents: [2000, 5000, 10000],
  /** Top-up credit expires this many months after purchase. */
  lastsMonths: 12,
  /** Unspent Top-up credit is refundable for this many days after purchase. */
  refundDays: 14,
} as const;

export interface ComputerSizeSpec {
  size: ComputerSize;
  name: string;
  vcpus: number;
  memoryGb: number;
}

export const COMPUTER_SIZES: readonly ComputerSizeSpec[] = [
  { size: "small", name: "Small", vcpus: 2, memoryGb: 4 },
  { size: "medium", name: "Medium", vcpus: 2, memoryGb: 8 },
  { size: "large", name: "Large", vcpus: 4, memoryGb: 16 },
  { size: "xl", name: "XL", vcpus: 8, memoryGb: 32 },
];

/** Linux Computer rates per hour, by size. */
export const LINUX_CENTS_PER_HOUR: Readonly<Record<ComputerSize, number>> = {
  small: 4,
  medium: 8,
  large: 16,
  xl: 32,
};

export const WINDOWS_COMPUTER = {
  size: "large" as ComputerSize,
  centsPerHour: 47,
  /** The monthly Licence charge. Null until it is read from AWS Marketplace (launch blocker 2). */
  licenceChargeCentsPerMonth: null as number | null,
};

export const MACOS_COMPUTER = { centsPerDay: 1872, minimumDays: 1 } as const;

/** Linux and Windows Computers go Asleep after this long with no activity (the default). */
export const ASLEEP_AFTER_MINUTES = 15;

/** "$20", "$1,000", "$0.04", "$18.72". */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function computerSize(size: ComputerSize): ComputerSizeSpec {
  return COMPUTER_SIZES.find((spec) => spec.size === size)!;
}

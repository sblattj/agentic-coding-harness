// `extra.credits` / `totals.credits` carry two DIFFERENT vendor units in one
// field: kiro metering credits and GitHub Copilot AIU ("AI credits", 1 AIU =
// US$0.01, #23). Any total over that field must keep the units apart, so this
// module is the one place that decides which unit a figure is in and how a
// per-unit total is worded.

export type CreditUnit = "kiro" | "copilot";

/** Display name of each unit, as used in dash footers and summaries. */
export const CREDIT_UNIT_LABEL: Record<CreditUnit, string> = {
  kiro: "credits",
  copilot: "AI credits",
};

/** The unit an agent's credits figures are in. Every non-copilot agent that reports credits is kiro. */
export function creditUnitOfAgent(agent: string | undefined): CreditUnit {
  return agent === "copilot" ? "copilot" : "kiro";
}

/** Per-unit running totals, insertion-ordered by first sight. */
export class CreditTotals {
  private readonly byUnit = new Map<CreditUnit, number>();

  add(unit: CreditUnit, value: number): void {
    this.byUnit.set(unit, (this.byUnit.get(unit) ?? 0) + value);
  }

  get isEmpty(): boolean {
    return this.byUnit.size === 0;
  }

  get(unit: CreditUnit): number | undefined {
    return this.byUnit.get(unit);
  }

  /**
   * One phrase per unit. A kiro-only total keeps the historical wording
   * (`credits 1.20cr`); once a copilot figure is present every phrase names
   * its vendor: `credits (kiro) 12.30cr · AI credits (copilot) 4.00cr`.
   */
  format(fmt: (n: number) => string): string {
    const units = (["kiro", "copilot"] as const).filter((u) => this.byUnit.has(u));
    if (units.length === 1 && units[0] === "kiro") return `${CREDIT_UNIT_LABEL.kiro} ${fmt(this.byUnit.get("kiro")!)}`;
    return units.map((u) => `${CREDIT_UNIT_LABEL[u]} (${u}) ${fmt(this.byUnit.get(u)!)}`).join(" · ");
  }
}

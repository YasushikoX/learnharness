/**
 * One refusal budget for every refusing gate (WP6, 2026-11-25).
 *
 * Each gate that refuses a teacher's tool call (prose, lead floor, visual, verdict, finish, sources, the give-away
 * option check, and upstream's narration guard) makes the model retry, and a run of retries costs time and is a
 * suspected cause of replies that stop halfway. Before this change each gate could refuse three times on its own; now
 * all of them share one small budget per learner turn: at most REFUSALS_PER_GATE refusals by any one gate and
 * REFUSALS_PER_TURN in total. Once a gate's share or the total is spent, the call passes and the pass is reported
 * (`onPass`, the turn timeline's `refusalBudgetPasses`).
 *
 * WHERE A TURN BEGINS AND ENDS: the chat handler builds one fresh Agent per request (a learner's answer, message,
 * Continue or Retry, or an automatic wake), and baseAgentOptions makes one budget per Agent. So the count lives exactly
 * as long as one learner turn: it survives the many model requests inside that turn (the force-text step, the check
 * nudge's follow-up, retries after a refusal) and starts again at zero on the next turn.
 */

/** The most refusals one gate may make in one learner turn. */
export const REFUSALS_PER_GATE = 2;
/** The most refusals all gates together may make in one learner turn. */
export const REFUSALS_PER_TURN = 3;
/**
 * Gates outside the turn's total (review 1, finding 2): they keep their own REFUSALS_PER_GATE whatever the other gates
 * spent, and what they refuse does not use up the others' total. `finish` is the one gate whose pass changes what is
 * recorded about the learner (a lesson logged as finished with no final problem), so three refusals by other gates
 * earlier in the turn must not wave it through unrefused.
 */
export const OWN_SHARE_GATES: readonly string[] = ["finish", "vocabulary"];

/**
 * Gates whose share in one learner turn is smaller than REFUSALS_PER_GATE. `vocabulary` (WP5, the finish check of a
 * lesson's terms, core/coverage-ledger.ts) refuses at most ONCE per lesson, which the transcript decides (a refusal on
 * record is never repeated); this allowance of one per turn is the in-turn guard for calls that run before that record
 * exists. Two finish calls in ONE message are one refusal event: the teacher agent hands the second the first's refusal
 * without counting it again (review 2, finding 3). It is outside the turn's total and has its own count, so it can never
 * spend a refusal the final-problem requirement (`finish`) needs.
 */
export const GATE_ALLOWANCES: Readonly<Record<string, number>> = { vocabulary: 1 };

export interface RefusalBudgetEvents {
	/** A gate refused (counts toward the budget). */
	onRefusal?: (gate: string) => void;
	/** A gate would have refused, but its share or the turn's total was spent: the call passed. */
	onPass?: (gate: string) => void;
}

/** A refusal counter for one learner turn: `refuse(gate, blocks, reason)` is the block result while the budget allows,
 *  then undefined (the call passes). A gate that does not block is not counted. */
export function makeRefusalBudget(perGate = REFUSALS_PER_GATE, perTurn = REFUSALS_PER_TURN, events: RefusalBudgetEvents = {}) {
	const byGate: Record<string, number> = {};
	let total = 0;
	return (gate: string, blocks: boolean, reason: string): { block: true; reason: string } | undefined => {
		if (!blocks) return undefined;
		const used = byGate[gate] ?? 0;
		const ownShare = OWN_SHARE_GATES.includes(gate);
		if (used >= Math.min(perGate, GATE_ALLOWANCES[gate] ?? perGate) || (!ownShare && total >= perTurn)) {
			events.onPass?.(gate);
			return undefined;
		}
		byGate[gate] = used + 1;
		if (!ownShare) total++;
		events.onRefusal?.(gate);
		return { block: true, reason };
	};
}

import { blendedPrice, billedPerOutput, isVariant } from './modelPicker';
import { ModelInfo, Usage } from './types';

/**
 * Economy mode moves the work that does not need the strongest model onto a cheap
 * one: conversation summaries, follow-up suggestions and read-only sub-agents.
 * File edits and the main conversation stay on the model the user chose.
 */

/**
 * A cheap model still has to hold a whole conversation to summarize it, and a
 * sub-agent needs room to read files, so tiny context windows are not useful here.
 */
const MIN_ECONOMY_CONTEXT = 128_000;
/** Below this the two models cost so nearly the same that delegating only adds risk. */
const MIN_PRICE_RATIO = 2;

export interface EconomyRouting {
	/** The cheap model that handles delegated work. */
	model: string;
	contextWindow?: number;
	maxTokens?: number;
	/** Route sub-agents to the cheap model, restricted to read-only tools. */
	subagents?: boolean;
}

/** Alternate billing or routing suffixes, so `x:free` and `x` count as the same model. */
function baseId(id: string): string {
	return id.toLowerCase().replace(/:(free|batch|extended|thinking|online|floor|nitro)$/, '');
}

export function sameModel(a: string | undefined, b: string | undefined): boolean {
	return !!a && !!b && baseId(a) === baseId(b);
}

/**
 * Picks the cheapest model that is still usable for delegated work. Free models
 * rank first because their blended price is zero.
 */
export function pickEconomyModel(models: ModelInfo[], options: { needTools?: boolean } = {}): ModelInfo | undefined {
	const usable = models.filter(m => {
		const price = blendedPrice(m);
		// An unpriced model cannot be shown to be cheaper, and a per-image price is not per-token.
		if (price === undefined || billedPerOutput(m)) { return false; }
		if (m.deprecatedAt || isVariant(m)) { return false; }
		if (m.contextWindow < MIN_ECONOMY_CONTEXT) { return false; }
		// Delegated work is tool work, so a model that cannot call tools is no help.
		return !(options.needTools !== false && !m.supportsTools);
	});
	return usable.sort((a, b) =>
		blendedPrice(a)! - blendedPrice(b)!
		|| b.contextWindow - a.contextWindow
		|| a.name.localeCompare(b.name))[0];
}

/**
 * Whether delegating to `economy` can actually save money. A model that is not
 * clearly cheaper than the one in use would only add failed turns.
 */
export function worthDelegating(main: ModelInfo | undefined, economy: ModelInfo | undefined): boolean {
	if (!economy) { return false; }
	const cheap = blendedPrice(economy);
	if (cheap === undefined) { return false; }
	// Without a price for the chosen model (such as auto routing) a cheap model is still the safer bet.
	const expensive = main ? blendedPrice(main) : undefined;
	if (expensive === undefined) { return true; }
	if (cheap === 0) { return expensive > 0; }
	return expensive / cheap >= MIN_PRICE_RATIO;
}

/**
 * What this request would have cost on the model the user picked, minus what it
 * actually cost. Undefined when either figure is unknown, so a guess is never
 * counted as a saving. Can be negative if the cheap model was not cheaper.
 */
export function savingAgainst(usage: Pick<Usage, 'promptTokens' | 'completionTokens' | 'cost'>, main: ModelInfo | undefined): number | undefined {
	if (!main || usage.cost === undefined || !Number.isFinite(usage.cost)) { return undefined; }
	const prompt = main.promptPricePerMillion;
	const completion = main.completionPricePerMillion;
	if (prompt === undefined || completion === undefined) { return undefined; }
	const wouldHaveCost = (usage.promptTokens * prompt + usage.completionTokens * completion) / 1_000_000;
	return wouldHaveCost - usage.cost;
}

export interface SavingsTally {
	/** Requests that ran on the economy model. */
	requests: number;
	saved: number;
	/** Economy requests whose saving could not be priced, so they are not in `saved`. */
	unpriced: number;
}

export const NO_SAVINGS: SavingsTally = { requests: 0, saved: 0, unpriced: 0 };

export function addSaving(tally: SavingsTally, saving: number | undefined): SavingsTally {
	return {
		requests: tally.requests + 1,
		saved: tally.saved + (saving ?? 0),
		unpriced: tally.unpriced + (saving === undefined ? 1 : 0),
	};
}

function dollars(value: number): string {
	const absolute = Math.abs(value);
	return `$${absolute < 0.01 ? absolute.toFixed(6) : absolute.toFixed(4)}`;
}

/**
 * A label for the savings chip and a longer explanation for its tooltip. Always
 * approximate: it compares real usage with the list price of a model that never ran.
 */
export function formatSavings(tally: SavingsTally): { label: string; detail: string } | undefined {
	if (tally.requests === 0) { return undefined; }
	const requests = `${tally.requests} request${tally.requests === 1 ? '' : 's'} ran on the economy model`;
	const unpriced = tally.unpriced ? ` ${tally.unpriced} could not be priced and ${tally.unpriced === 1 ? 'is' : 'are'} left out.` : '';
	if (tally.unpriced === tally.requests) {
		return { label: 'economy on', detail: `${requests}, but no price was published for the model you picked, so no saving can be shown.${unpriced}` };
	}
	if (tally.saved < 0) {
		return { label: `~${dollars(tally.saved)} extra`, detail: `${requests} and cost about ${dollars(tally.saved)} more than the model you picked would have.${unpriced}` };
	}
	return {
		label: `~${dollars(tally.saved)} saved`,
		detail: `Estimated: ${requests}. Compared with the list price of the model you picked for the same tokens, that is about ${dollars(tally.saved)} less.${unpriced}`,
	};
}

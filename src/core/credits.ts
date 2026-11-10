import { LiveLimit } from './gateway';

export const BUY_URL = 'https://openrouter.ai/settings/credits';

export interface SpendRecord {
	/** Calendar month as YYYY-MM. */
	month: string;
	total: number;
	/** Key fingerprint (first 8 chars) this total belongs to, so a key switch does not mix accounts. */
	keyId?: string;
}

export type CreditLevel = 'ok' | 'low' | 'empty';

export interface CreditStatus {
	label: string;
	detail: string;
	level: CreditLevel;
	live: boolean;
}

const LOW_RATIO = 0.1;
/** Shown only when the live balance could not be read, so the number is a local tally. */
const ESTIMATE_NOTE = 'This is counted on this computer because the balance could not be read from OpenRouter just now.';

export function currentMonth(now = new Date()): string {
	return now.toISOString().slice(0, 7);
}

/** Local spend for this month on this key. An old month's or another key's total is not this key's spend. */
export function spentThisMonth(record: SpendRecord | undefined, now = new Date(), keyId?: string): number {
	return record?.month === currentMonth(now) && record.keyId === keyId ? record.total : 0;
}

/**
 * Why the next request must not be sent, or undefined when it may go ahead.
 * A budget that only colours a label is not a budget, so this is checked before
 * every request and names the setting that lets the user carry on.
 */
export function budgetStop(record: SpendRecord | undefined, userLimit: number, live?: LiveLimit, now = new Date(), keyId?: string): string | undefined {
	if (live && (live.reached || live.remaining <= 0)) {
		const what = live.scope === 'key' ? "this key's limit" : 'your OpenRouter credits';
		return `No credit left: ${money(live.used, live.currency)} of ${money(live.limit, live.currency)} used on ${what}. Add credits or switch to another key before sending more.`;
	}
	if (userLimit > 0) {
		const spent = spentThisMonth(record, now, keyId);
		if (spent >= userLimit) {
			return `Your own monthly limit of ${money(userLimit)} is used up: about ${money(spent)} counted on this computer this month. Raise openrouter.monthlySpendLimit, or set it to 0 to turn your limit off. ${ESTIMATE_NOTE}`;
		}
	}
	return undefined;
}

export function addSpend(record: SpendRecord | undefined, cost: number, now = new Date(), keyId?: string): SpendRecord {
	const month = currentMonth(now);
	const same = record?.month === month && record?.keyId === keyId;
	return { month, total: (same ? record.total : 0) + cost, keyId };
}

/** Discards results from old connections and from out-of-order balance reads. */
export class CreditRefreshGuard {
	private connection: string | undefined;
	private generation = 0;

	reset(connection?: string): number {
		this.connection = connection;
		return ++this.generation;
	}

	begin(connection: string): number | undefined {
		return this.connection === connection ? ++this.generation : undefined;
	}

	isCurrent(connection: string | undefined, generation: number): boolean {
		return this.connection === connection && this.generation === generation;
	}

	matches(connection: string): boolean {
		return this.connection === connection;
	}
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export function money(value: number, currency?: string): string {
	const symbol = (currency && SYMBOLS[currency.toUpperCase()]) ?? (currency ? `${currency.toUpperCase()} ` : '$');
	return `${symbol}${value < 1 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

function level(remaining: number, limit: number): CreditLevel {
	if (remaining <= 0) { return 'empty'; }
	return remaining / limit <= LOW_RATIO ? 'low' : 'ok';
}

/** Prefers OpenRouter's own figures. Otherwise compares local spend with the user's own limit. */
export function creditStatus(record: SpendRecord | undefined, userLimit: number, live?: LiveLimit, now = new Date(), keyId?: string): CreditStatus {
	if (live) {
		const reset = live.resetsAt ? ` Resets ${live.resetsAt.slice(0, 10)}.` : '';
		const localSpend = spentThisMonth(record, now, keyId);
		const local = localSpend > 0 ? ` This month on this computer: ~${money(localSpend)} in reported request costs.` : '';
		const what = live.scope === 'key' ? "this key's limit" : 'your OpenRouter credits';
		return {
			label: `${money(live.remaining, live.currency)} left`,
			detail: `From ${what}: ${money(live.used, live.currency)} used of ${money(live.limit, live.currency)}${live.period ? ` (${live.period})` : ''}.${reset}${local}`,
			level: live.reached ? 'empty' : level(live.remaining, live.limit),
			live: true,
		};
	}
	// The local counter is per key and per month; an old key's or month's record is not this key's spend.
	const spent = spentThisMonth(record, now, keyId);
	if (userLimit > 0) {
		const remaining = Math.max(userLimit - spent, 0);
		return {
			label: `~${money(remaining)} left (est.)`,
			detail: `About ${money(spent)} of your own ${money(userLimit)} monthly limit, for this key only. ${ESTIMATE_NOTE}`,
			level: level(remaining, userLimit),
			live: false,
		};
	}
	return {
		label: `~${money(spent)} this month`,
		detail: `Spent this month on the current key. ${ESTIMATE_NOTE}`,
		level: 'ok',
		live: false,
	};
}

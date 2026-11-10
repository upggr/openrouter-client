import { ModelInfo } from './types';

export type ModelSort = 'recommended' | 'cheapest' | 'smartest' | 'context' | 'name';

export interface SortOption {
	id: ModelSort;
	label: string;
	detail: string;
}

export const SORT_OPTIONS: SortOption[] = [
	{ id: 'recommended', label: 'Recommended', detail: 'Capable models first, grouped by vendor' },
	{ id: 'cheapest', label: 'Cheapest first', detail: 'Free models, then lowest price per million tokens' },
	{ id: 'smartest', label: 'Strongest first', detail: 'Highest published benchmark score' },
	{ id: 'context', label: 'Largest context', detail: 'Most context tokens first' },
	{ id: 'name', label: 'Name', detail: 'Alphabetical, grouped by vendor' },
];

/** Price of a typical turn, used to rank models that charge differently for input and output. */
export function blendedPrice(model: ModelInfo): number | undefined {
	const prompt = model.promptPricePerMillion;
	const completion = model.completionPricePerMillion;
	if (prompt === undefined && completion === undefined) { return undefined; }
	// Roughly three input tokens per output token in chat, so weight input more heavily.
	return (prompt ?? 0) * 0.75 + (completion ?? 0) * 0.25;
}

export function isFree(model: ModelInfo): boolean {
	return blendedPrice(model) === 0 && !billedPerOutput(model);
}

/**
 * Image, audio and video models publish zero per-token prices because they bill per
 * image or per second instead, so a free token price does not mean a free request.
 */
export function billedPerOutput(model: ModelInfo): boolean {
	return model.outputModalities.some(m => m !== 'TEXT');
}

/** Alternate billing or routing variants of a model, such as `:batch` or `:nitro`. */
const VARIANT = /:(batch|extended|thinking|online|floor|nitro)$/;

export function isVariant(model: ModelInfo): boolean {
	return VARIANT.test(model.id);
}

/** A model whose price depends on where the request is routed, such as openrouter/auto. */
export function priceVaries(model: ModelInfo): boolean {
	return blendedPrice(model) === undefined;
}

export function formatPrice(model: ModelInfo): string {
	if (priceVaries(model)) { return 'price varies'; }
	if (isFree(model)) { return 'free'; }
	// Billed per image or per second, so the per-token figure would understate the cost.
	if (billedPerOutput(model) && blendedPrice(model) === 0) { return 'priced per output'; }
	const money = (value: number | undefined) => {
		if (value === undefined) { return '?'; }
		// Cheap models cost fractions of a cent per million, so keep enough digits to tell them apart.
		if (value === 0) { return '$0'; }
		return value < 1 ? `$${Number(value.toFixed(3))}` : `$${Number(value.toFixed(2))}`;
	};
	return `${money(model.promptPricePerMillion)}/${money(model.completionPricePerMillion)} per M`;
}

export function formatContext(model: ModelInfo): string {
	const tokens = model.contextWindow;
	if (tokens >= 1_000_000) { return `${Number((tokens / 1_000_000).toFixed(1))}M context`; }
	if (tokens >= 1_000) { return `${Math.round(tokens / 1_000)}K context`; }
	return `${tokens} context`;
}

/** The best published score for a model, preferring measures that match coding work. */
export function bestScore(model: ModelInfo): number | undefined {
	return model.agenticScore ?? model.codingScore ?? model.intelligence;
}

/**
 * How suitable a model is as a default pick: strong published scores first, then
 * the practical things that make a model usable here, with cost as a tiebreaker.
 */
function recommendedRank(model: ModelInfo): number {
	let rank = bestScore(model) ?? 0;
	// Without tools the agent cannot edit files, so those models are never a good default.
	if (!model.supportsTools) { rank -= 100; }
	if (model.deprecatedAt) { rank -= 50; }
	// Alternate billing variants of the same model only add noise to the top of the list.
	if (isVariant(model)) { rank -= 25; }
	if (model.contextWindow >= 200_000) { rank += 3; }
	const price = blendedPrice(model);
	if (price !== undefined && price > 0) { rank -= Math.min(price / 20, 5); }
	return rank;
}

function byName(a: ModelInfo, b: ModelInfo): number {
	return a.name.localeCompare(b.name);
}

/** Orders models for display. Grouping by vendor is applied separately. */
export function sortModels(models: ModelInfo[], sort: ModelSort): ModelInfo[] {
	const list = [...models];
	switch (sort) {
		case 'cheapest':
			return list.sort((a, b) => {
				const pa = blendedPrice(a);
				const pb = blendedPrice(b);
				// Models with no fixed price cannot be compared, so they sit at the end.
				if (pa === undefined && pb === undefined) { return byName(a, b); }
				if (pa === undefined) { return 1; }
				if (pb === undefined) { return -1; }
				// Keep per-image and per-second models out of the cheap end of a per-token list.
				const oa = Number(billedPerOutput(a) && pa === 0);
				const ob = Number(billedPerOutput(b) && pb === 0);
				if (oa !== ob) { return oa - ob; }
				return pa - pb || Number(isVariant(a)) - Number(isVariant(b)) || byName(a, b);
			});
		case 'smartest':
			// Variants score identically to their base model, so they would pair up and halve the list.
			return list.sort((a, b) => (bestScore(b) ?? -1) - (bestScore(a) ?? -1) || Number(isVariant(a)) - Number(isVariant(b)) || byName(a, b));
		case 'context':
			return list.sort((a, b) => b.contextWindow - a.contextWindow || byName(a, b));
		case 'name':
			return list.sort(byName);
		default:
			return list.sort((a, b) => recommendedRank(b) - recommendedRank(a) || byName(a, b));
	}
}

export interface ModelFilter {
	/** Only models that can call tools, which the agent needs to edit files. */
	toolsOnly?: boolean;
	/** Only models that cost nothing. */
	freeOnly?: boolean;
	/** Only models that accept images. */
	visionOnly?: boolean;
	/** Highest acceptable blended price per million tokens. */
	maxPrice?: number;
	/** Restrict to one vendor, such as `anthropic`. */
	family?: string;
}

export function filterModels(models: ModelInfo[], filter: ModelFilter): ModelInfo[] {
	return models.filter(model => {
		if (filter.toolsOnly && !model.supportsTools) { return false; }
		if (filter.visionOnly && !model.supportsImages) { return false; }
		if (filter.freeOnly && !isFree(model)) { return false; }
		if (filter.family && model.family !== filter.family) { return false; }
		if (filter.maxPrice !== undefined) {
			const price = blendedPrice(model);
			if (price === undefined || price > filter.maxPrice) { return false; }
		}
		return true;
	});
}

export interface ModelGroup {
	label: string;
	models: ModelInfo[];
}

/**
 * Splits a sorted list into labelled groups for the picker. Vendor grouping keeps
 * a long catalogue navigable; the ranked sorts stay in one list so the order is not lost.
 */
export function groupModels(models: ModelInfo[], sort: ModelSort): ModelGroup[] {
	if (sort === 'cheapest' || sort === 'smartest' || sort === 'context') {
		return [{ label: '', models }];
	}
	const byFamily = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const list = byFamily.get(model.family) ?? [];
		list.push(model);
		byFamily.set(model.family, list);
	}
	const groups = [...byFamily.entries()].map(([label, list]) => ({ label, models: list }));
	if (sort === 'name') {
		return groups.sort((a, b) => a.label.localeCompare(b.label));
	}
	// Recommended: vendors appear in the order their best model does.
	return groups;
}

/** Vendors present in a catalogue, ordered by how many models each offers. */
export function families(models: ModelInfo[]): { id: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const model of models) { counts.set(model.family, (counts.get(model.family) ?? 0) + 1); }
	return [...counts.entries()]
		.map(([id, count]) => ({ id, count }))
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

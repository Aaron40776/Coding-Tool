import type { SmartConfig } from './core/config.js';
import type { History } from './core/rating/learn.js';
import { rateTask, rungLabel } from './core/rating/rate.js';

/**
 * `smart --rate "<task>"`: shows how the rater would score a request, with no model call and no cost. It uses the local
 * signals and your history only. In a real run the classifier's opinion (and, per plan step, the planner's) is blended in too,
 * so the real choice can differ by a rung when they disagree with the text.
 */
export function describeRating(text: string, config: SmartConfig, history?: History): string[] {
  const r = rateTask({ text, config, history });
  return [
    `Task: ${text.length > 100 ? `${text.slice(0, 97)}...` : text}`,
    ...r.detail.map((d) => `  ${d}`),
    '',
    `Result: ${rungLabel(r.rung)}, rated ${r.score.toFixed(2)}, ${Math.round(r.confidence * 100)}% sure`,
    'This is the local part only (no model was called). A real run also blends in the classifier\'s complexity and difficulty, and the planner\'s rating of each step.',
    `Tune it with routing.optimize (${config.routing.optimize} now), the routing.<complexity> floors, keywordRules and runner.effort; see ROUTING.md.`,
  ];
}

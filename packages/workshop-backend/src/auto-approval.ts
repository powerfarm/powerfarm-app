// Auto-approval drain core: applies eligible pending actions in id order, with a per-gatekeeper
// single-flight guard so two concurrent drains (the DO's input gate is open across the apply await)
// can't double-apply the same action. The apply is injected, keeping this constructible over a
// mock storage in tests.

import type { Collection, Singleton } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;

  /**
   * The two sensitive-data restriction singletons (see makeOverseerStorage): the legacy
   * whole-workspace boolean, and the per-gatekeeper provenance set. A gatekeeper in the set (or
   * any gatekeeper under the legacy boolean) must never have actions auto-approved.
   */
  prohibitAllSharing: Singleton<boolean>;
  sensitiveGatekeeperIds: Singleton<number[]>;
}

/**
 * True if actions on this gatekeeper are restricted by the sensitive-data policy: either the
 * gatekeeper itself produced a sensitive observation, or the workspace carries the legacy
 * whole-workspace restriction (unknown provenance, so every gatekeeper is suspect).
 */
export function isSensitiveGatekeeper(
    storage: AutoApprovalStorage, gatekeeperId: number): boolean {
  return storage.prohibitAllSharing.get() ||
      storage.sensitiveGatekeeperIds.get().includes(gatekeeperId);
}

/**
 * The single authority on whether an action may be applied without a human. Returns the enabling
 * rule iff ALL of:
 *  - the gatekeeper author marked this specific action `autoApprovable`,
 *  - the action carries an `actionKind` for which the user enabled a rule on this gatekeeper,
 *  - the action carries no `operatorWarnings` (a warning exists precisely to be read by the
 *    human approver, so it forces manual approval),
 *  - the gatekeeper is not restricted by the sensitive-data policy (writes-to-self are allowed
 *    to *pend*, but a human must look at each one).
 * Returns undefined otherwise: manual approval required.
 */
export function autoApprovalRule(
    storage: AutoApprovalStorage, gatekeeperId: number, description: ActionDescription)
    : AutoApproveTagRecord | undefined {
  if (description.autoApprovable !== true) return undefined;
  let tag = description.actionKind?.tag;
  if (tag === undefined) return undefined;
  if (description.operatorWarnings !== undefined && description.operatorWarnings.length > 0) {
    return undefined;
  }
  if (isSensitiveGatekeeper(storage, gatekeeperId)) return undefined;
  return storage.autoApproveTags.get(`${gatekeeperId}:${tag}`);
}

/**
 * Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
 * caller has already validated that the record is still pending.
 */
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state. Key present => a drain is running for that gatekeeper; the
  // value is a "rerun" flag, set when another drain is requested while one is in flight, so work
  // submitted during a drain isn't lost.
  #draining = new Map<number, boolean>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn) {}

  async drain(gatekeeperId: number): Promise<void> {
    if (this.#draining.has(gatekeeperId)) {
      this.#draining.set(gatekeeperId, true);  // ask the running drain to loop again
      return;
    }
    this.#draining.set(gatekeeperId, false);
    try {
      do {
        this.#draining.set(gatekeeperId, false);
        await this.#drainOnce(gatekeeperId);
      } while (this.#draining.get(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops at
  // the first pending action that is NOT auto-eligible (a manual gate) or that throws while applying
  // -- it is never skipped ahead of. This preserves in-order application and the invariant that
  // nothing is silently applied past a human gate.
  //
  // Eligibility is `autoApprovalRule()`: the author's `autoApprovable` verdict, a user-enabled
  // rule for the action's kind, no operator warnings, and a gatekeeper not restricted by the
  // sensitive-data policy.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Materialize a snapshot first: list() is a lazy generator over storage, and we mutate the
    // actions collection (via applyPendingAction) as we go.
    let pending = [...this.storage.actions.list()].filter(
        (rec): rec is ActionRecord & {type: "action"} =>
            rec.gatekeeperId === gatekeeperId && rec.type === "action" && rec.state === "pending");

    for (let record of pending) {
      let rule = autoApprovalRule(this.storage, gatekeeperId, record.description);
      if (rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        break;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        await this.applyPendingAction(fresh, rule.enabledBy, true);
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        break;
      }
    }
  }
}

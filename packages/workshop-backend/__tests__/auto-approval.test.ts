import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  AutoApprovalDrainer, AutoApprovalStorage, ApplyPendingActionFn, autoApprovalRule,
  isSensitiveGatekeeper,
} from "../src/auto-approval.js";
import { computeSensitiveGatekeeperBackfill } from "../src/overseer.js";
import type { ActionRecord, AutoApproveTagRecord } from "../src/overseer.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): AutoApprovalStorage {
  return createTypedStorage(makeMockStorage(), {
    singletons: {
      prohibitAllSharing: false,
      sensitiveGatekeeperIds: <number[]>[],
    },
    collections: {
      actions: collection<ActionRecord>()({ primaryKey: "id" }),
      autoApproveTags: collection<AutoApproveTagRecord>()({
        primaryKey: (r: AutoApproveTagRecord) => `${r.gatekeeperId}:${r.actionKind.tag}`,
      }),
    },
  });
}

const GK = 1;
const ENABLER: AiChatAuthorInfo = { type: "user", id: "enabler@example.com", name: "Enabler" };

function enableRule(storage: AutoApprovalStorage, actionTag = "edit", gatekeeperId = GK) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER });
}

function putAction(
    storage: AutoApprovalStorage, id: number,
    opts: { gatekeeperId?: number; actionTag?: string; autoApprovable?: boolean;
            operatorWarnings?: string[]; state?: ActionRecord["state"] } = {}) {
  storage.actions.put({
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action: id,
    description: {
      title: `Action ${id}`,
      description: `Action ${id} description`,
      implementsRevert: true,
      actionKind: { tag: opts.actionTag ?? "edit", label: "Edits" },
      autoApprovable: opts.autoApprovable ?? true,
      ...(opts.operatorWarnings ? { operatorWarnings: opts.operatorWarnings } : {}),
    },
  });
}

function getAction(storage: AutoApprovalStorage, id: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

// An apply fn that resolves immediately, mirroring OverseerImpl.applyPendingAction's effect:
// mark the record approved and persist. Records the order of applied action ids.
function makeImmediateApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let applyFn: ApplyPendingActionFn = async (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    let fresh = storage.actions.get(record.id);
    if (fresh && fresh.type === "action") {
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.resolvedBy = resolvedBy;
      fresh.autoApproved = autoApproved;
      storage.actions.put(fresh);
    }
  };
  return { applyFn, calls };
}

// An apply fn whose every invocation parks on a test-held promise until released. Lets a test hold
// an apply mid-flight (input gate open) while launching a second concurrent drain. On release it
// performs the same approve+persist effect as the real apply.
function makeControlledApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let gates: Array<() => void> = [];
  let applyFn: ApplyPendingActionFn = (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    return new Promise<void>((resolve) => {
      gates.push(() => {
        let fresh = storage.actions.get(record.id);
        if (fresh && fresh.type === "action") {
          fresh.state = "approved";
          fresh.appliedAt = new Date();
          fresh.resolvedBy = resolvedBy;
          fresh.autoApproved = autoApproved;
          storage.actions.put(fresh);
        }
        resolve();
      });
    });
  };
  return {
    applyFn,
    calls,
    inFlight: () => gates.length,
    releaseNext() {
      let gate = gates.shift();
      if (!gate) throw new Error("no apply in flight to release");
      gate();
    },
  };
}

// Drain all microtasks (and the macrotask queue) so suspended drain continuations run to their next
// park point.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AutoApprovalDrainer.drain", () => {
  it("applies all eligible pending actions in ascending id order", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 2, 3]);
    for (let id of [1, 2, 3]) {
      let record = getAction(storage, id);
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(true);
      expect(record.resolvedBy?.id).toBe(ENABLER.id);
    }
  });

  it("stops at a manual gate without skipping ahead, then resumes once it clears", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });  // manual gate
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn);
    await drainer.drain(GK);

    // Only the action before the gate is applied; the gate and everything behind it stay pending.
    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");

    // Clear the gate (as a manual approval would) and re-drain: the rest applies, still in order.
    let gate = getAction(storage, 2);
    gate.state = "approved";
    storage.actions.put(gate);
    await drainer.drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 3).state).toBe("approved");
  });

  // Two concurrent drains for the same gatekeeper must not double-apply. The input gate is open
  // across the apply await, so without the single-flight guard the second drain's pending re-check
  // would see the still-"pending" record and apply it again.
  it("never applies an action more than once under concurrent drains", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // starts, calls apply(1), parks mid-apply
    let second = drainer.drain(GK);  // must coalesce, not start a second apply
    await second;

    expect(apply.calls).toEqual([1]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // resolve apply(1); record becomes approved
    await first;                     // rerun pass re-lists: action 1 no longer pending -> no re-apply

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  // Work that arrives while a drain is parked must still be applied -- the coalescing
  // "rerun" flag must not drop the wakeup.
  it("applies work submitted while a drain is parked mid-apply", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // parks mid-apply on action 1

    putAction(storage, 2);           // new eligible action arrives mid-drain
    let second = drainer.drain(GK);  // coalesces -> sets the rerun flag
    await second;
    expect(apply.calls).toEqual([1]);

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // finish action 2
    await first;

    expect(apply.calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });
});

// A description that passes every gate, for the predicate tests to knock single gates out of.
function eligibleDescription(overrides: Partial<ActionDescription> = {}): ActionDescription {
  return {
    title: "Edit the thing",
    description: "Edits the thing.",
    implementsRevert: true,
    actionKind: { tag: "edit", label: "Edits" },
    autoApprovable: true,
    ...overrides,
  };
}

describe("autoApprovalRule", () => {
  it("returns the enabling rule when every gate passes", () => {
    let storage = makeStorage();
    enableRule(storage);
    let rule = autoApprovalRule(storage, GK, eligibleDescription());
    expect(rule?.enabledBy).toEqual(ENABLER);
  });

  it("requires the author's autoApprovable verdict", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(storage, GK, eligibleDescription({ autoApprovable: undefined })))
        .toBeUndefined();
    expect(autoApprovalRule(storage, GK, eligibleDescription({ autoApprovable: false })))
        .toBeUndefined();
  });

  it("requires an actionKind", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(storage, GK, eligibleDescription({ actionKind: undefined })))
        .toBeUndefined();
  });

  it("requires a user-enabled rule for the kind on this gatekeeper", () => {
    let storage = makeStorage();
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    enableRule(storage, "edit", GK + 1);  // right tag, wrong gatekeeper
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    enableRule(storage, "delete", GK);    // right gatekeeper, wrong tag
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
  });

  it("refuses any action carrying operator warnings", () => {
    let storage = makeStorage();
    enableRule(storage);
    expect(autoApprovalRule(
        storage, GK, eligibleDescription({ operatorWarnings: ["watch out"] })))
        .toBeUndefined();
    // An empty array carries no warning to read, so it does not disqualify.
    expect(autoApprovalRule(storage, GK, eligibleDescription({ operatorWarnings: [] })))
        .toBeDefined();
  });

  it("refuses a gatekeeper that produced a sensitive observation", () => {
    let storage = makeStorage();
    enableRule(storage);
    storage.sensitiveGatekeeperIds.put([GK]);
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    // Another gatekeeper is unaffected by GK's taint.
    enableRule(storage, "edit", GK + 1);
    expect(autoApprovalRule(storage, GK + 1, eligibleDescription())).toBeDefined();
  });

  it("refuses every gatekeeper under the legacy whole-workspace restriction", () => {
    let storage = makeStorage();
    enableRule(storage);
    storage.prohibitAllSharing.put(true);
    expect(autoApprovalRule(storage, GK, eligibleDescription())).toBeUndefined();
    expect(isSensitiveGatekeeper(storage, GK)).toBe(true);
    expect(isSensitiveGatekeeper(storage, GK + 1)).toBe(true);
  });
});

describe("AutoApprovalDrainer sensitive/warned gates", () => {
  it("stops at a warned action without skipping ahead", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1, { operatorWarnings: ["cross-account data risk"] });
    putAction(storage, 2);

    let apply = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, apply.applyFn).drain(GK);

    expect(apply.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
    expect(getAction(storage, 2).state).toBe("pending");
  });

  it("applies nothing on a sensitive gatekeeper even with a matching rule", async () => {
    let storage = makeStorage();
    enableRule(storage);
    storage.sensitiveGatekeeperIds.put([GK]);
    putAction(storage, 1);

    let apply = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, apply.applyFn).drain(GK);

    expect(apply.calls).toEqual([]);
    expect(getAction(storage, 1).state).toBe("pending");
  });
});

describe("computeSensitiveGatekeeperBackfill", () => {
  function observation(
      id: number, gatekeeperId: number,
      description: Record<string, unknown>): ActionRecord {
    return {
      id,
      gatekeeperId,
      caller: { from: "agent", chatId: 1 },
      createdAt: new Date(),
      state: "approved",
      type: "observation",
      description: {
        title: `Observation ${id}`,
        description: `Observation ${id} description`,
        ...description,
      },
    } as ActionRecord;
  }

  it("collects distinct gatekeepers from sensitive observations under either flag name", () => {
    // Records written before the rename carry `prohibitAllSharing` verbatim in storage; records
    // written after carry `containsRestrictedData`. Both must count.
    let actions: ActionRecord[] = [
      observation(1, 7, { prohibitAllSharing: true }),
      observation(2, 7, { containsRestrictedData: true }),
      observation(3, 9, { containsRestrictedData: true }),
      observation(4, 11, {}),
    ];
    expect(computeSensitiveGatekeeperBackfill(actions).toSorted()).toEqual([7, 9]);
  });

  it("ignores action records and the builtin-tool sentinel", () => {
    let actions: ActionRecord[] = [
      observation(1, -1, { containsRestrictedData: true }),  // builtin webFetch etc.
      {
        id: 2,
        gatekeeperId: 7,
        caller: { from: "agent", chatId: 1 },
        createdAt: new Date(),
        state: "pending",
        type: "action",
        action: 2,
        description: {
          title: "Act", description: "Acts.", implementsRevert: false,
          // Hypothetical action carrying a stray flag: still not an observation.
          containsRestrictedData: true,
        } as ActionDescription,
      },
    ];
    expect(computeSensitiveGatekeeperBackfill(actions)).toEqual([]);
  });

  it("returns nothing when no sensitive observation exists (the no-provenance safety net)", () => {
    expect(computeSensitiveGatekeeperBackfill([observation(1, 7, {})])).toEqual([]);
  });
});

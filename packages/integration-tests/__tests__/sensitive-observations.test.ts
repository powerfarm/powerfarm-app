// Tests for the sensitive-data (`containsRestrictedData`) observation policy.
//
// A sensitive observation used to be blocked outright whenever the workspace had any share at all,
// and latched a lockdown that also blocked all future sharing. Observer verification replaced the
// sharing side of that: a sensitive observation is now blocked only while some *current
// collaborator* has not been verified (via `addObserver`) against the gatekeeper producing it, and
// sharing stays available afterwards -- recipients are verified when they open. The restricted-mode
// half is unchanged: once latched, the workspace may not perform actions (nor fetch from the web,
// which has no client-reachable surface to assert here).
//
// The fixture gatekeeper's session drives all of this through the real ApprovalQueue funnel:
// `readThing(true)` records a `containsRestrictedData` observation, `doThing()` submits an action.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  accountLabel, connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
let interceptor: NetworkInterceptor;

beforeAll(async () => {
  interceptor = new NetworkInterceptor();
  interceptor.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  const unmocked = interceptor.getUnmockedCalls();
  await harness?.server.close();
  interceptor.uninstall();
  interceptor.reset();
  expect(unmocked).toEqual([]);
});

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

function thingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}`;
}

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

/** Tell the fixture gatekeeper whether to admit `label` as an observer. */
async function setVerifyOutcome(
    label: string, outcome: { allow: true } | { allow: false; reason: string }): Promise<void> {
  const res = await harness.fetchWorker(
    TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/verify-outcome",
    { method: "POST", body: JSON.stringify({ label, ...outcome }) });
  if (res.status !== 204) {
    throw new Error(`Setting the verify outcome failed with ${res.status}: ${await res.text()}`);
  }
}

type Workspace = {
  gadgetId: string;
  overseer: RpcStub<Overseer>;
  aliceApi: RpcStub<AuthenticatedApi>;
  /** The fixture session bound to the workspace's (first) gatekeeper. */
  session: any;
  gatekeeperId: number;
};

// Alice creates a workspace bound to one Test Thing and opens a session on its gatekeeper. Every
// test starts here; collaborators and links are layered on per test.
async function newWorkspace(publicApi: RpcStub<PublicApi>, thingName: string): Promise<Workspace> {
  const [alice] = nextUsernames("alice");
  const aliceApi = await signUp(publicApi, alice);
  const account = await provisionAccount(aliceApi);

  const overseer = await aliceApi.newGadget();
  const gatekeeper = await overseer.newGatekeeper(account.id, thingUrl(thingName));
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const gatekeeperId = await gatekeeper.getId();
  const session = await gatekeeper.openSession();
  const { id: gadgetId } = await overseer.getMetadata();
  return { gadgetId, overseer, aliceApi, session, gatekeeperId };
}

// Sign Bob up, add him as a collaborator, and give him his own fixture account.
async function addBob(publicApi: RpcStub<PublicApi>, ws: Workspace): Promise<{
  bobApi: RpcStub<AuthenticatedApi>;
  bobAccount: ConnectedAccount;
  bobLabel: string;
}> {
  const [bob] = nextUsernames("bob");
  const bobApi = await signUp(publicApi, bob);
  const bobAccount = await provisionAccount(bobApi);
  const collaborator = await ws.overseer.addCollaborator(bob, "build");
  if (!collaborator) throw new Error(`Failed to share the gadget with ${bob}`);
  return { bobApi, bobAccount, bobLabel: accountLabel(bobAccount) };
}

// Bob opens the workspace, answering observer prompts with his own account. This is what writes
// his observer record, i.e. verifies him against every in-scope gatekeeper.
async function bobOpens(ws: Workspace, bobApi: RpcStub<AuthenticatedApi>,
                        bobAccount: ConnectedAccount): Promise<RpcStub<Overseer>> {
  const recorder = new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS);
  const callback = stubFor(recorder);
  try {
    return await bobApi.openGadget(ws.gadgetId, undefined, callback);
  } finally {
    callback[Symbol.dispose]();
  }
}

describe("sensitive observations", () => {
  it.concurrent("latch restricted mode: only writes-to-self are allowed and metadata reports it",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "latch");

      // Before the latch, actions submit fine and metadata is clean.
      await expect(ws.session.doThing()).resolves.toBeUndefined();
      expect((await ws.overseer.getMetadata()).containsRestrictedData).toBeFalsy();

      await expect(ws.session.readThing(true)).resolves.toContain("latch");

      expect((await ws.overseer.getMetadata()).containsRestrictedData).toBe(true);

      // Actions targeting the gatekeeper that produced the sensitive data still pend (the
      // writes-to-self carve-out: the data came from there, so sending it back reveals nothing
      // new). Actions on any other connection are blocked.
      await expect(ws.session.doThing()).resolves.toBeUndefined();
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const other = await ws.overseer.newGatekeeper(account.id, thingUrl("latch-other"));
      if (!other) throw new Error("Failed to create the second test connection");
      const otherSession: any = await other.openSession();
      await expect(otherSession.doThing())
          .rejects.toThrow(/only perform actions on those same connections/i);

      // Reads -- sensitive or not -- keep working.
      await expect(ws.session.readThing()).resolves.toContain("latch");
      await expect(ws.session.readThing(true)).resolves.toContain("latch");
    });
  });

  it.concurrent("an unredeemed share link does not block a sensitive observation", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unredeemed");
      await ws.overseer.createShareLink("build", "never redeemed");

      // Nobody has redeemed the link, so nobody unverified can be watching: the observation
      // proceeds. (Redemption happens inside open(), where observer verification gates it.)
      await expect(ws.session.readThing(true)).resolves.toContain("unredeemed");
    });
  });

  it.concurrent("sharing stays available after the latch", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "share-after");
      await expect(ws.session.readThing(true)).resolves.toContain("share-after");

      // All three sharing RPCs used to throw "the workspace cannot be shared" once latched.
      const [carol] = nextUsernames("carol");
      await signUp(publicApi, carol);
      await expect(ws.overseer.addCollaborator(carol, "build")).resolves.toMatchObject({
        profile: expect.objectContaining({ id: expect.any(String) }),
      });
      const { linkId } = await ws.overseer.createShareLink("use", "post-latch");
      await expect(ws.overseer.newShareLinkKey(linkId)).resolves.toMatchObject({
        key: expect.any(String),
      });
    });
  });

  it.concurrent("an unverified collaborator blocks a sensitive observation", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "unverified");
      await addBob(publicApi, ws);

      // Bob has access but has never opened, so he holds no observer record for this gatekeeper.
      // He may hold a live session the moment he does open, so the observation must not proceed.
      await expect(ws.session.readThing(true)).rejects.toThrow(/has not been verified/i);
      // Non-sensitive reads are unaffected.
      await expect(ws.session.readThing()).resolves.toContain("unverified");
    });
  });

  it.concurrent("a verified collaborator allows the sensitive observation through", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "verified");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws, bob.bobApi, bob.bobAccount))[Symbol.dispose]();

      await expect(ws.session.readThing(true)).resolves.toContain("verified");
    });
  });

  it.concurrent("a verified collaborator does not cover a gatekeeper added later", async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "covered");
      const bob = await addBob(publicApi, ws);
      (await bobOpens(ws, bob.bobApi, bob.bobAccount))[Symbol.dispose]();

      // A second connection Bob has never been verified against.
      const accounts = await listConnectedAccounts(ws.aliceApi);
      const account = accounts.find(a => a.vendorId === TEST_VENDOR_ID)!;
      const late = await ws.overseer.newGatekeeper(account.id, thingUrl("late"));
      if (!late) throw new Error("Failed to create the second test connection");
      const lateSession: any = await late.openSession();

      await expect(lateSession.readThing(true)).rejects.toThrow(/has not been verified/i);
      // The gatekeeper Bob is verified against still reads fine.
      await expect(ws.session.readThing(true)).resolves.toContain("covered");
    });
  });

  it.concurrent("a collaborator can open a workspace that latched before they were added",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "open-after");
      await expect(ws.session.readThing(true)).resolves.toContain("open-after");

      // Adding Bob and having him open both used to be impossible post-latch. His open runs
      // observer verification, which the fixture admits by default.
      const bob = await addBob(publicApi, ws);
      using bobOverseer = await bobOpens(ws, bob.bobApi, bob.bobAccount);
      await expect(bobOverseer.getMetadata()).resolves.toMatchObject({
        id: ws.gadgetId,
        containsRestrictedData: true,
      });
    });
  });

  it.concurrent("a collaborator the gatekeeper refuses is denied at open, with its reason",
      async () => {
    await withSession(async publicApi => {
      const ws = await newWorkspace(publicApi, "refused");
      await expect(ws.session.readThing(true)).resolves.toContain("refused");

      const bob = await addBob(publicApi, ws);
      const reason = "You do not have access to this thing.";
      await setVerifyOutcome(bob.bobLabel, { allow: false, reason });

      // This is the strategy-A shape: enforcement lives in the gatekeeper's addObserver(), not in
      // a wholesale sharing block, so the user sees the gatekeeper's own message.
      const error = await bobOpens(ws, bob.bobApi, bob.bobAccount).then(
        overseer => { overseer[Symbol.dispose](); return null; },
        (err: unknown) => err as Error);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/could not confirm/i);
      expect(error!.message).toContain(reason);
    });
  });
});

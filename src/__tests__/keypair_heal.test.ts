// @vitest-environment node
/**
 * Device-identity self-heal.
 *
 * safeStorage (Windows DPAPI / macOS Keychain / Linux libsecret) is bound to
 * the OS user + machine. When the app-data folder is copied to another PC (e.g.
 * running the unpackaged app from a shared/portable drive), the stored private
 * key can't be decrypted there — which used to make swarm.start() throw and
 * silently disable networking (no socket bound → no Windows Firewall prompt).
 *
 * These tests pin the fix: an undecryptable identity is detected and a fresh
 * one is regenerated so networking works on the new machine.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Stable state shared across module resets (simulates the on-disk DB + the
// machine-bound DPAPI key).
const h = vi.hoisted(() => ({
  state: { rows: [] as any[], machineKey: "MACHINE_A", nextId: 1 },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Tag ciphertext with the "machine key"; decryption only works on the same.
    encryptString: (s: string) =>
      Buffer.from(h.state.machineKey + "|" + s, "utf-8"),
    decryptString: (buf: Buffer) => {
      const str = buf.toString("utf-8");
      const idx = str.indexOf("|");
      if (str.slice(0, idx) !== h.state.machineKey) {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        );
      }
      return str.slice(idx + 1);
    },
  },
}));

vi.mock("@/db/schema", () => ({ deviceIdentity: {} }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({ limit: () => ({ all: () => h.state.rows.slice() }) }),
    }),
    delete: () => ({
      run: () => {
        h.state.rows.length = 0;
      },
    }),
    insert: () => ({
      values: (v: any) => ({
        run: () => {
          h.state.rows.push({ id: h.state.nextId++, ...v });
        },
      }),
    }),
  },
}));

beforeEach(() => {
  h.state.rows.length = 0;
  h.state.machineKey = "MACHINE_A";
  h.state.nextId = 1;
  vi.resetModules();
});

describe("device identity self-heal", () => {
  it("generates and reads back a usable key on a fresh machine", async () => {
    const kp = await import("@/main/identity/keypair");
    const id = await kp.getOrCreateKeypair();
    expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const priv = await kp.getPrivateKeyBytes();
    expect(priv.length).toBe(32);
    expect(h.state.rows).toHaveLength(1);
  });

  it("regenerates the identity when the DB was copied from another machine", async () => {
    // Machine A creates the identity.
    const kpA = await import("@/main/identity/keypair");
    const idA = await kpA.getOrCreateKeypair();
    expect(h.state.rows).toHaveLength(1);

    // Copy the app data to machine B: same DB rows, different DPAPI key, fresh
    // process (module cache cleared).
    h.state.machineKey = "MACHINE_B";
    vi.resetModules();
    const kpB = await import("@/main/identity/keypair");

    // On B the old key is undecryptable → heal: new identity, still exactly one row.
    const idB = await kpB.getOrCreateKeypair();
    expect(idB.publicKey).not.toBe(idA.publicKey);
    expect(h.state.rows).toHaveLength(1);

    // And networking can now read a usable private key on machine B — the
    // call that previously threw and disabled the whole network.
    const privB = await kpB.getPrivateKeyBytes();
    expect(privB.length).toBe(32);
  });

  it("getPrivateKeyBytes heals even if called before getOrCreateKeypair", async () => {
    const kpA = await import("@/main/identity/keypair");
    await kpA.getOrCreateKeypair();
    h.state.machineKey = "MACHINE_C";
    vi.resetModules();
    const kpC = await import("@/main/identity/keypair");
    const priv = await kpC.getPrivateKeyBytes();
    expect(priv.length).toBe(32);
    expect(h.state.rows).toHaveLength(1);
  });
});

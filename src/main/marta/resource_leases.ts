export interface ResourceLease {
  key: string;
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface LeaseConflict {
  key: string;
  owner: string;
  expiresAt: number;
}

export type LeaseAcquisition =
  | { ok: true; leases: ResourceLease[] }
  | { ok: false; conflicts: LeaseConflict[] };

/**
 * Atomic, expiring resource leases for parallel Marta workstreams.
 *
 * All requested keys are checked before any is acquired. Sorting the keys and
 * making acquisition all-or-nothing removes the partial-lock deadlock that a
 * collection of ad-hoc booleans would create.
 */
export class ResourceLeaseManager {
  private readonly leases = new Map<string, ResourceLease>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly defaultTtlMs = 120_000,
  ) {}

  acquire(
    owner: string,
    keys: readonly string[],
    ttlMs = this.defaultTtlMs,
  ): LeaseAcquisition {
    const requested = [
      ...new Set(keys.map((key) => key.trim()).filter(Boolean)),
    ].sort();
    this.reapExpired();

    const conflicts = requested.flatMap((key) => {
      const lease = this.leases.get(key);
      return lease && lease.owner !== owner
        ? [{ key, owner: lease.owner, expiresAt: lease.expiresAt }]
        : [];
    });
    if (conflicts.length > 0) return { ok: false, conflicts };

    const at = this.now();
    const leases = requested.map((key) => {
      const existing = this.leases.get(key);
      const lease: ResourceLease = {
        key,
        owner,
        acquiredAt: existing?.owner === owner ? existing.acquiredAt : at,
        expiresAt: at + Math.max(1, ttlMs),
      };
      this.leases.set(key, lease);
      return { ...lease };
    });
    if (leases.length > 0) this.notify();
    return { ok: true, leases };
  }

  heartbeat(owner: string, ttlMs = this.defaultTtlMs): number {
    const at = this.now();
    let renewed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.owner !== owner) continue;
      this.leases.set(key, { ...lease, expiresAt: at + Math.max(1, ttlMs) });
      renewed += 1;
    }
    if (renewed > 0) this.notify();
    return renewed;
  }

  release(owner: string, keys?: readonly string[]): number {
    const filter = keys ? new Set(keys) : null;
    let released = 0;
    for (const [key, lease] of this.leases) {
      if (lease.owner !== owner || (filter && !filter.has(key))) continue;
      this.leases.delete(key);
      released += 1;
    }
    if (released > 0) this.notify();
    return released;
  }

  snapshot(): ResourceLease[] {
    this.reapExpired();
    return [...this.leases.values()]
      .map((lease) => ({ ...lease }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reapExpired(): void {
    const at = this.now();
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt > at) continue;
      this.leases.delete(key);
      changed = true;
    }
    if (changed) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

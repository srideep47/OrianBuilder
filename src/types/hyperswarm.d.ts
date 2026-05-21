declare module "hyperswarm" {
  import { EventEmitter } from "events";

  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface HyperswarmOptions {
    keyPair?: KeyPair;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
  }

  interface PeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
  }

  class Hyperswarm extends EventEmitter {
    constructor(options?: HyperswarmOptions);
    join(topic: Buffer, options?: { server?: boolean; client?: boolean }): void;
    leave(topic: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(
      event: "connection",
      listener: (
        socket: NodeJS.ReadWriteStream & {
          remotePublicKey: Buffer;
          publicKey: Buffer;
        },
        info: PeerInfo,
      ) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export = Hyperswarm;
}

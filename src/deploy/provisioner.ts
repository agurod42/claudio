import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord } from "./types.js";

export interface Provisioner {
  provision(userId: string, authDir: string, whatsappId: string): Promise<GatewayInstanceRecord>;
}

export class NoopProvisioner implements Provisioner {
  constructor(private store: DeployStore) {}

  async provision(
    userId: string,
    authDir: string,
    _whatsappId: string,
  ): Promise<GatewayInstanceRecord> {
    const instance = await this.store.createGatewayInstanceForUser(userId, authDir);
    const running = await this.store.updateGatewayInstanceStatus(instance.id, "running", null);
    return running ?? instance;
  }
}

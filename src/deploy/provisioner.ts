import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord } from "./types.js";
import type { ModelTier } from "./types.js";

export type ProvisionOptions = {
  modelTier?: ModelTier;
};

export interface Provisioner {
  provision(
    userId: string,
    authDir: string,
    whatsappId: string,
    options?: ProvisionOptions,
  ): Promise<GatewayInstanceRecord>;
  deprovision(instance: GatewayInstanceRecord): Promise<GatewayInstanceRecord | null>;
}

export class NoopProvisioner implements Provisioner {
  constructor(private store: DeployStore) {}

  async provision(
    userId: string,
    authDir: string,
    _whatsappId: string,
    _options?: ProvisionOptions,
  ): Promise<GatewayInstanceRecord> {
    const instance = await this.store.createGatewayInstanceForUser(userId, authDir);
    const running = await this.store.updateGatewayInstanceStatus(instance.id, "running", null);
    return running ?? instance;
  }

  async deprovision(instance: GatewayInstanceRecord): Promise<GatewayInstanceRecord | null> {
    return await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
  }
}

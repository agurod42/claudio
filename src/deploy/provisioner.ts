import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord } from "./types.js";
import type { ModelTier } from "./types.js";

export type ProvisionOptions = {
  modelTier?: ModelTier;
};

export type ProvisionResult = {
  instance: GatewayInstanceRecord;
  healthy: boolean;
};

export interface Provisioner {
  provision(
    userId: string,
    authDir: string,
    whatsappId: string,
    options?: ProvisionOptions,
  ): Promise<ProvisionResult>;
  deprovision(userId: string): Promise<void>;
  inspectStatus(userId: string): Promise<GatewayInstanceRecord["status"] | null>;
  restartContainer(userId: string): Promise<boolean>;
  reconcile(): Promise<void>;
}

export class NoopProvisioner implements Provisioner {
  constructor(private store: DeployStore) {}

  async provision(
    userId: string,
    authDir: string,
    _whatsappId: string,
    _options?: ProvisionOptions,
  ): Promise<ProvisionResult> {
    const instance = await this.store.createGatewayInstanceForUser(userId, authDir);
    const running = await this.store.updateGatewayInstanceStatus(instance.id, "running", null);
    return { instance: running ?? instance, healthy: true };
  }

  async deprovision(userId: string): Promise<void> {
    const instance = await this.store.getGatewayInstanceByUserId(userId);
    if (instance) {
      await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
    }
  }

  async inspectStatus(userId: string): Promise<GatewayInstanceRecord["status"] | null> {
    const instance = await this.store.getGatewayInstanceByUserId(userId);
    return instance?.status ?? null;
  }

  async restartContainer(_userId: string): Promise<boolean> {
    return false;
  }

  async reconcile(): Promise<void> {}
}

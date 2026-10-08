/** App access beneath model-facing Tools. Connectors never grant Role permissions. */
export interface Connector<Request, Result, Options = void> {
  readonly id: string;
  readonly app: string;
  readonly capabilities: readonly string[];
  invoke(request: Request, options: Options): Promise<Result>;
}

/** Each registry belongs to one runtime scope; credentials are not process-global. */
export class ConnectorRegistry<C extends Connector<never, unknown, never> = Connector<never, unknown, never>> {
  private readonly connectors = new Map<string, C>();

  register<T extends C>(connector: T): T {
    if (!connector.id.trim() || this.connectors.has(connector.id)) {
      throw new Error(`CONNECTOR_ID_CONFLICT: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
    return connector;
  }

  get(id: string): C | undefined { return this.connectors.get(id); }

  values(): C[] { return [...this.connectors.values()]; }

  list(): Array<{ id: string; app: string; capabilities: readonly string[] }> {
    return [...this.connectors.values()].map(({ id, app, capabilities }) => ({
      id, app, capabilities: [...capabilities],
    }));
  }
}

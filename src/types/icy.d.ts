declare module "icy" {
  import type { ClientRequest, IncomingMessage } from "node:http";

  export type IcyHeaders = Record<string, string>;
  export type IcyOptions = { headers?: IcyHeaders };

  export function get(
    url: string,
    options: IcyOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function get(
    url: string,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;

  export function parse(metadata: Buffer): Record<string, string>;

  const icy: {
    get: typeof get;
    parse: typeof parse;
  };

  export default icy;
}



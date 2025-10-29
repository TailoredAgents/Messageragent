declare module 'point-of-view' {
  import type { FastifyPluginCallback } from 'fastify';
  const pointOfView: FastifyPluginCallback<any>;
  export = pointOfView;
}

declare module 'fastify' {
  interface FastifyReply {
    view: (page: string, data?: Record<string, unknown>) => this;
  }
}

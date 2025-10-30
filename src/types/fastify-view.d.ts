declare module '@fastify/view' {
  import type { FastifyPluginCallback } from 'fastify/types/plugin';
  const fastifyView: FastifyPluginCallback;
  export default fastifyView;
}

declare module 'fastify/types/reply' {
  interface FastifyReply {
    view: (page: string, data?: Record<string, unknown>) => this;
  }
}

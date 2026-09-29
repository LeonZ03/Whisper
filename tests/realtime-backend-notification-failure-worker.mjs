import worker from '../cloud/worker.mjs';
export { RealtimeHub } from '../cloud/realtime.mjs';
export default {
  ...worker,
  fetch(request, env, ctx) {
    const binding = env.REALTIME;
    return worker.fetch(request, { ...env, REALTIME: {
      idFromName: name => binding.idFromName(name),
      get(id) {
        const stub = binding.get(id);
        return { fetch(request) {
          if (new URL(request.url).pathname === '/notify') throw Error('Isolated notification failure');
          return stub.fetch(request);
        } };
      }
    } }, ctx);
  }
};

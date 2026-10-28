// MOCK adapter for tests only: returns whatever URL the test passes in env, never contacts a real service.
module.exports = {
  meta: { requiredEnv: ["PROVIDER_MOCK_ADAPTER_URL"], movie: true, tv: false },
  async resolve(ctx) { return [{ url: ctx.env.PROVIDER_MOCK_ADAPTER_URL, type: "mp4", label: "mock adapter" }]; },
};

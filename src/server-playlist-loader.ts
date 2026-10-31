import type { HlsConfig, LoaderCallbacks, LoaderConfiguration, PlaylistLoaderContext } from "hls.js";

function finiteBudget(value: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

// hls.js shortens blocking reloads to 0.8 * targetduration even when loading
// complete segments. Use its public pLoader extension to retain this origin's
// finite playlist budget, without changing fragment loading or library globals.
export function createServerPlaylistLoader(Loader: HlsConfig["loader"]): NonNullable<HlsConfig["pLoader"]> {
  // The general loader also handles playlist contexts; specialize its context
  // type here because this class is supplied exclusively through pLoader.
  const BasePlaylistLoader = Loader as NonNullable<HlsConfig["pLoader"]>;
  return class ServerPlaylistLoader extends BasePlaylistLoader {
    private readonly firstByteMs: number;
    private readonly totalMs: number;

    constructor(config: HlsConfig) {
      super(config);
      const policy = config.playlistLoadPolicy.default;
      this.totalMs = finiteBudget(policy.maxLoadTimeMs, 8_000);
      this.firstByteMs = Math.min(finiteBudget(policy.maxTimeToFirstByteMs, 4_000), this.totalMs);
    }

    override load(context: PlaylistLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>): void {
      const part = context.deliveryDirectives?.part;
      const mediaPlaylist = context.type === "level" || context.type === "audioTrack" || context.type === "subtitleTrack";
      if (!mediaPlaylist || typeof part !== "number" || !Number.isFinite(part) || part < 0) {
        super.load(context, config, callbacks);
        return;
      }
      super.load(context, {
        ...config,
        loadPolicy: { ...config.loadPolicy, maxTimeToFirstByteMs: this.firstByteMs, maxLoadTimeMs: this.totalMs },
      }, callbacks);
    }
  };
}

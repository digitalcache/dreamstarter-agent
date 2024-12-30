import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";

class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        this.client = new ClientBase(runtime, twitterConfig);
        this.post = new TwitterPostClient(this.client, runtime);

        if (twitterConfig.TWITTER_SEARCH_ENABLE) {
            // this searches topics from character file
            elizaLogger.warn("Twitter/X client running in a mode that:");
            elizaLogger.warn("1. violates consent of random users");
            elizaLogger.warn("2. burns your rate limit");
            elizaLogger.warn("3. can get your account banned");
            elizaLogger.warn("use at your own risk");
            this.search = new TwitterSearchClient(this.client, runtime);
        }

        this.interaction = new TwitterInteractionClient(this.client, runtime);
    }
}

export type TwitterClient = {
    /** Start client connection */
    start: (runtime: IAgentRuntime) => Promise<unknown>;
    /** Stop client connection */
    stop: (runtime: IAgentRuntime) => Promise<unknown>;
    /** Start external client connection */
    startExternal: (
        runtime: IAgentRuntime,
        email: string,
        username: string,
        password: string
    ) => Promise<unknown>;
};

export const TwitterClientInterface: TwitterClient = {
    async startExternal(
        runtime: IAgentRuntime,
        email: string,
        username: string,
        password: string
    ) {
        // await validateTwitterConfig(runtime);

        elizaLogger.log("Twitter client started");
        const twitterConfig: TwitterConfig =
            await validateTwitterConfig(runtime);
        console.log("here", twitterConfig);
        const manager = new TwitterManager(runtime, twitterConfig);

        await manager.client.init(email, username, password);

        await manager.post.start();

        await manager.interaction.start();

        if (manager.search) await manager.search.start();

        return manager;
    },
    async start(runtime: IAgentRuntime) {
        console.log(runtime);
        // const twitterConfig: TwitterConfig =
        //     await validateTwitterConfig(runtime);

        // elizaLogger.log("Twitter client started");

        // const manager = new TwitterManager(runtime, twitterConfig);

        // // await manager.client.init();

        // await manager.post.start();

        // if (manager.search) await manager.search.start();

        // await manager.interaction.start();

        // return manager;
    },
    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;

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
        this.search = new TwitterSearchClient(this.client, runtime);
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
        const manager = new TwitterManager(runtime, twitterConfig);

        const status = await manager.client.init(email, username, password);

        // await manager.post.start();

        // await manager.interaction.start();

        // await manager.search.start();

        return {
            loginSuccess: status,
            manager: manager,
        };
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
        const xClient = _runtime.clients.twitter as TwitterManager;
        if (xClient) {
            elizaLogger.log("Twitter client trying to stop");
            await xClient.post.stop();
            await xClient.post.stopNewTweets();
            await xClient.interaction.stop();
            await xClient.search.stop();
            return xClient;
        }
    },
};

export default TwitterClientInterface;

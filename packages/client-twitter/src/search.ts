import { IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base";

export class TwitterSearchClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.runtime.getSetting("TWITTER_USERNAME");
    }

    async start() {
        this.engageWithSearchTermsLoop();
    }

    private engageWithSearchTermsLoop() {
        this.engageWithSearchTerms().then();
    }

    private async engageWithSearchTerms() {
        console.log("Engaging with search terms");
        try {
            const searchTerm = this.runtime.character.twitterQuery;

            console.log("Fetching profiles to follow");
            // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const potentialProfiles = await this.client.fetchSearchProfiles(
                searchTerm,
                10
            );

            if (potentialProfiles?.profiles?.length) {
                console.log("Found profiles to follow");
                for (const profile of potentialProfiles.profiles) {
                    if (profile.username === this.twitterUsername) {
                        continue;
                    }

                    console.log("Following", profile.username);
                    await this.client.twitterClient.followUser(
                        profile.username
                    );
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                }
            }
        } catch (error) {
            console.error("Error engaging with search terms:", error);
        }
    }
}

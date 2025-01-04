import { IAgentRuntime } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base";

export class TwitterSearchClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    numFollowed: number;
    enableFollow: boolean;
    private timeoutId: NodeJS.Timeout | null;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.numFollowed = 0;
        this.twitterUsername = this.runtime.getSetting("TWITTER_USERNAME");
        this.enableFollow = false;
        this.timeoutId = null;
    }

    async start() {
        if (this.enableFollow) {
            this.engageWithSearchTermsLoop();
        }
    }

    async stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
            this.enableFollow = false;
            elizaLogger.log("Twitter search loop stopped");
        }
    }

    private engageWithSearchTermsLoop() {
        this.engageWithSearchTerms().then();
        elizaLogger.log(`Next twitter follow scheduled in 1 day`);
        this.timeoutId = setTimeout(
            () => this.engageWithSearchTermsLoop(),
            24 * 60 * 60 * 1000
        );
    }

    private getRandomWord(searchTerm: string): string {
        const words = searchTerm.split(" ");
        const randomIndex = Math.floor(Math.random() * words.length);
        return words[randomIndex];
    }

    private async engageWithSearchTerms() {
        console.log("Engaging with search terms");
        try {
            const searchTerm = this.runtime.character.twitterQuery;

            console.log("Fetching profiles to follow");
            // TODO: we wait 5 seconds here to avoid getting rate limited on startup, but we should queue
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const potentialProfiles = await this.client.fetchSearchProfiles(
                this.getRandomWord(searchTerm),
                15
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
                    this.numFollowed++;
                    await new Promise((resolve) =>
                        setTimeout(resolve, 7200000)
                    );
                }
            }
        } catch (error) {
            console.error("Error engaging with search terms:", error);
        }
    }
}

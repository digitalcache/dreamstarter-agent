import { IAgentRuntime } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base";

export class TwitterSearchClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    numFollowed: number;
    timeoutId: NodeJS.Timeout | null;
    private enableFollow: boolean;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.numFollowed = 0;
        this.twitterUsername = this.runtime.getSetting("TWITTER_USERNAME");
        this.timeoutId = null;
        this.enableFollow = false;
    }

    async start() {
        this.enableFollow = true;

        const engageWithSearchTermsLoop = () => {
            try {
                this.engageWithSearchTerms();
                this.timeoutId = setTimeout(
                    () => engageWithSearchTermsLoop(),
                    24 * 60 * 60 * 1000
                );
                elizaLogger.log(`Next twitter follow scheduled in 1 day`);
            } catch (error) {
                elizaLogger.log(`Error in search terms loop: ${error}`);
                // Retry after error with exponential backoff
                this.timeoutId = setTimeout(
                    () => engageWithSearchTermsLoop(),
                    5 * 60 * 1000 // 5 minutes
                );
            }
        };

        engageWithSearchTermsLoop();
    }

    async stop() {
        this.enableFollow = false;

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
            elizaLogger.log("Twitter search loop stopped");
        }
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
            // TODO: we wait 50 seconds here to avoid getting rate limited on startup, but we should queue
            await new Promise((resolve) => setTimeout(resolve, 50000));
            const potentialProfiles = await this.client.fetchSearchProfiles(
                this.getRandomWord(searchTerm),
                15
            );

            if (potentialProfiles?.profiles?.length) {
                console.log(
                    `Found ${potentialProfiles.profiles.length} profiles to follow`
                );
                for (const profile of potentialProfiles.profiles) {
                    if (!this.enableFollow) {
                        console.log("Stopping follow loop");
                        break;
                    }
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

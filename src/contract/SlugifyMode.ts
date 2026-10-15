// Based on Markdown All in One
// <https://github.com/yzhang-gh/vscode-markdown>
// MIT License, Copyright (c) 2017 张宇

/**
 * Slugify mode.
 */
export const enum SlugifyMode {
    /** Azure DevOps */
    AzureDevOps = "azureDevops",

    /** Bitbucket Cloud */
    BitbucketCloud = "bitbucket-cloud",

    /** Gitea */
    Gitea = "gitea",

    /** GitHub */
    GitHub = "github",

    /** GitLab */
    GitLab = "gitlab",

    /** Visual Studio Code */
    VisualStudioCode = "vscode",

    /** Zola */
    Zola = "zola",
}

export default SlugifyMode;

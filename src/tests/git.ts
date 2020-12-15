import * as fs from "fs";
import { EOL } from "os";
import { join } from "path";
import { promisify } from "util";

import { Octokit } from "@octokit/rest";
import * as execa from "execa";
import * as tempy from "tempy";

import {
  CommitMessage,
  createTemporaryRef,
  fetchRefSha,
  PullRequestNumber,
  Ref,
  RepoName,
  RepoOwner,
  Sha,
} from "../git";

type CommitContent = string;

type CommitLines = string[];

type Commit = { lines: CommitLines; message: CommitMessage };

type RefState = Commit[];

type RepoState = {
  initialCommit: Commit;
  refsCommits: {
    [ref: string]: RefState;
  };
};

type CommandArgs = string[];

type CommandDirectory = string;

type CommandEnv = { [key: string]: string };

type DeleteRefs = () => Promise<void>;

type RefsDetails = { [ref: string]: { ref: Ref; shas: Sha[] } };

const lineSeparator = `${EOL}${EOL}`;
const filename = "file.txt";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const getContent = (lines: CommitLines) => lines.join(lineSeparator);
const getLines = (content: CommitContent) => content.split(lineSeparator);

const createBlob = async ({
  content,
  octokit,
  owner,
  repo,
}: {
  content: CommitContent;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}) => {
  const {
    data: { sha },
  } = await octokit.git.createBlob({
    content,
    owner,
    repo,
  });
  return sha;
};

const createTree = async ({
  blob,
  octokit,
  owner,
  repo,
}: {
  blob: Sha;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}) => {
  const {
    data: { sha: treeSha },
  } = await octokit.git.createTree({
    owner,
    repo,
    tree: [
      {
        mode: "100644",
        path: filename,
        sha: blob,
        type: "blob",
      },
    ],
  });
  return treeSha;
};

const createCommit = async ({
  message,
  octokit,
  owner,
  parent,
  repo,
  tree,
}: {
  message: CommitMessage;
  octokit: Octokit;
  owner: RepoOwner;
  parent?: Sha;
  repo: RepoName;
  tree: Sha;
}) => {
  const {
    data: { sha },
  } = await octokit.git.createCommit({
    message,
    owner,
    parents: parent == null ? [] : [parent],
    repo,
    tree,
  });
  return sha;
};

const createCommitFromLinesAndMessage = async ({
  commit: { lines, message },
  octokit,
  owner,
  parent,
  repo,
}: {
  commit: Commit;
  octokit: Octokit;
  owner: RepoOwner;
  parent?: Sha;
  repo: RepoName;
}): Promise<Sha> => {
  const content = getContent(lines);
  const blob = await createBlob({ content, octokit, owner, repo });
  const tree = await createTree({ blob, octokit, owner, repo });
  return createCommit({
    message,
    octokit,
    owner,
    parent,
    repo,
    tree,
  });
};

const createPullRequest = async ({
  base,
  head,
  octokit,
  owner,
  repo,
}: {
  base: Ref;
  head: Ref;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<PullRequestNumber> => {
  const {
    data: { number: pullRequestNumber },
  } = await octokit.pulls.create({
    base,
    head,
    owner,
    repo,
    title: "Untitled",
  });
  return pullRequestNumber;
};

const fetchContent = async ({
  octokit,
  owner,
  repo,
  ref,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  ref: Ref;
}) => {
  const { data } = (await octokit.repos.getContent({
    owner,
    path: filename,
    ref,
    repo,
  })) as {
    data: { content: string; encoding: BufferEncoding };
  };
  return Buffer.from(data.content, data.encoding).toString("utf8");
};

const fetchRefCommitsFromSha = async ({
  octokit,
  owner,
  repo,
  sha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  sha: Sha;
}): Promise<RefState> => {
  const content = await fetchContent({ octokit, owner, ref: sha, repo });

  const {
    data: { message, parents },
  } = await octokit.git.getCommit({ commit_sha: sha, owner, repo });

  const commit = { lines: getLines(content), message };

  if (parents.length !== 0) {
    const commits = await fetchRefCommitsFromSha({
      octokit,
      owner,
      repo,
      sha: parents[0].sha,
    });
    return [...commits, commit];
  }

  return [commit];
};

const fetchRefCommits = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
}): Promise<RefState> => {
  const sha = await fetchRefSha({
    octokit,
    owner,
    ref,
    repo,
  });
  return fetchRefCommitsFromSha({ octokit, owner, repo, sha });
};

const getLatestSha = (shas: Sha[]) => shas[shas.length - 1];

const internalCreateRefs = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  state: RepoState;
}) => {
  const initialCommitSha = await createCommitFromLinesAndMessage({
    commit: initialCommit,
    octokit,
    owner,
    repo,
  });

  const refNames = Object.keys(refsCommits);

  return Promise.all(
    refNames.map(async ref => {
      const shas = await refsCommits[ref].reduce(
        async (parentPromise, commit) => {
          const accumulatedShas = await parentPromise;
          const sha = await createCommitFromLinesAndMessage({
            commit,
            octokit,
            owner,
            parent: getLatestSha(accumulatedShas),
            repo,
          });
          return [...accumulatedShas, sha];
        },
        Promise.resolve([initialCommitSha]),
      );
      const {
        deleteTemporaryRef: deleteRef,
        temporaryRef,
      } = await createTemporaryRef({
        octokit,
        owner,
        ref,
        repo,
        sha: getLatestSha(shas),
      });
      return { deleteRef, shas, temporaryRef };
    }),
  );
};

const createRefs = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  state: RepoState;
}): Promise<{
  deleteRefs: DeleteRefs;
  refsDetails: RefsDetails;
}> => {
  const refNames = Object.keys(refsCommits);

  const refsDetails = await internalCreateRefs({
    octokit,
    owner,
    repo,
    state: { initialCommit, refsCommits },
  });

  return {
    async deleteRefs() {
      await Promise.all(refsDetails.map(({ deleteRef }) => deleteRef()));
    },
    refsDetails: refsDetails.reduce(
      (acc, { shas, temporaryRef }, index) =>
        Object.assign({}, acc, {
          [refNames[index]]: { ref: temporaryRef, shas },
        }),
      {},
    ),
  };
};

const executeGitCommandInCurrentRef = ({
  args,
  directory,
  env,
}: {
  args: CommandArgs;
  directory: CommandDirectory;
  env?: CommandEnv;
}) => execa.stdout("git", args, { cwd: directory, env });

const checkout = ({
  directory,
  ref,
}: {
  directory: CommandDirectory;
  ref: Ref;
}) =>
  executeGitCommandInCurrentRef({
    args: ["checkout", ref],
    directory,
  });

const executeGitCommand = async ({
  args,
  directory,
  env,
  ref,
}: {
  args: CommandArgs;
  directory: CommandDirectory;
  env?: CommandEnv;
  ref: Ref;
}) => {
  await checkout({ directory, ref });
  return executeGitCommandInCurrentRef({ args, directory, env });
};

const createGitRepoCommit = async ({
  commit: { lines, message },
  directory,
}: {
  commit: Commit;
  directory: CommandDirectory;
}) => {
  await writeFile(join(directory, filename), getContent(lines));
  await executeGitCommandInCurrentRef({
    args: ["add", filename],
    directory,
  });
  await executeGitCommandInCurrentRef({
    args: ["commit", "--message", message],
    directory,
  });
};

const createGitRepo = async ({ initialCommit, refsCommits }: RepoState) => {
  const directory = tempy.directory();
  await executeGitCommandInCurrentRef({ args: ["init"], directory });
  await createGitRepoCommit({ commit: initialCommit, directory });
  const refs = Object.keys(refsCommits);
  await refs.reduce(async (refPromise, ref) => {
    await refPromise;
    await (ref === "master"
      ? Promise.resolve()
      : executeGitCommandInCurrentRef({
          args: ["checkout", "-b", ref],
          directory,
        }));
  }, Promise.resolve());
  await refs.reduce(async (refPromise, ref) => {
    await refPromise;
    await checkout({ directory, ref });
    await refsCommits[ref].reduce(async (commitPromise, commit) => {
      await commitPromise;
      await createGitRepoCommit({ commit, directory });
    }, Promise.resolve());
  }, Promise.resolve());
  return directory;
};

const getRefShasFromGitRepo = async ({
  directory,
  ref,
}: {
  directory: CommandDirectory;
  ref: Ref;
}): Promise<Sha[]> => {
  const log = await executeGitCommand({
    args: ["log", "--pretty=format:%h"],
    directory,
    ref,
  });
  return log.split("\n").reverse();
};

const getRefCommitsFromGitRepo = async ({
  directory,
  ref,
}: {
  directory: CommandDirectory;
  ref: Ref;
}): Promise<RefState> => {
  const shas = await getRefShasFromGitRepo({ directory, ref });
  const initialCommits: Commit[] = [];
  return shas.reduce(async (waitForCommits, sha) => {
    const commits = await waitForCommits;
    await executeGitCommandInCurrentRef({
      args: ["checkout", sha],
      directory,
    });
    const [content, message] = await Promise.all([
      readFile(join(directory, filename)),
      executeGitCommandInCurrentRef({
        args: ["log", "--format=%B", "--max-count", "1"],
        directory,
      }),
    ]);
    return [
      ...commits,
      {
        lines: getLines(String(content)),
        message: message.trim(),
      },
    ];
  }, Promise.resolve(initialCommits));
};

export {
  CommandDirectory,
  createCommitFromLinesAndMessage,
  createGitRepo,
  createPullRequest,
  createRefs,
  DeleteRefs,
  executeGitCommand,
  fetchRefCommits,
  fetchRefCommitsFromSha,
  getRefCommitsFromGitRepo,
  getRefShasFromGitRepo,
  RefsDetails,
  RepoState,
};

import { Octokit } from "@octokit/rest";
import * as generateUuid from "uuid/v4";

type PullRequestNumber = number;

/**
 * A Git reference name.
 */
type Ref = string;

type RepoName = string;

type RepoOwner = string;

/**
 * A Git SHA-1.
 */
type Sha = string;

type CommitMessage = string;

type CommitAuthor =
  | {
      name?: string | undefined;
      email?: string | undefined;
      date?: string | undefined;
    }
  | undefined;

type CommitCommitter =
  | {
      name?: string | undefined;
      email?: string | undefined;
      date?: string | undefined;
    }
  | undefined;

type CommitDetails = {
  author: CommitAuthor;
  committer: CommitCommitter;
  message: CommitMessage;
  sha: Sha;
  tree: Sha;
};

const generateUniqueRef = (ref: Ref): Ref => `${ref}-${generateUuid()}`;
const getHeadRef = (ref: Ref): Ref => `heads/${ref}`;
const getFullyQualifiedRef = (ref: Ref): Ref => `refs/${getHeadRef(ref)}`;

const fetchRefSha = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
}): Promise<Sha> => {
  const {
    data: {
      object: { sha },
    },
  } = await octokit.git.getRef({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
  return sha;
};

const updateRef = async ({
  force,
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  force: boolean;
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
  sha: Sha;
}): Promise<void> => {
  await octokit.git.updateRef({
    force,
    owner,
    ref: getHeadRef(ref),
    repo,
    sha,
  });
};

const deleteRef = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
}): Promise<void> => {
  await octokit.git.deleteRef({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
};

const createRef = async ({
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
  sha: Sha;
}): Promise<void> => {
  await octokit.git.createRef({
    owner,
    ref: getFullyQualifiedRef(ref),
    repo,
    sha,
  });
};

const createTemporaryRef = async ({
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
  sha: Sha;
}): Promise<{
  deleteTemporaryRef: () => Promise<void>;
  temporaryRef: Ref;
}> => {
  const temporaryRef = generateUniqueRef(ref);
  await createRef({
    octokit,
    owner,
    ref: temporaryRef,
    repo,
    sha,
  });
  return {
    async deleteTemporaryRef() {
      await deleteRef({
        octokit,
        owner,
        ref: temporaryRef,
        repo,
      });
    },
    temporaryRef,
  };
};

const withTemporaryRef = async <T>({
  action,
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  action: (ref: Ref) => Promise<T>;
  octokit: Octokit;
  owner: RepoOwner;
  ref: Ref;
  repo: RepoName;
  sha: Sha;
}): Promise<T> => {
  const { deleteTemporaryRef, temporaryRef } = await createTemporaryRef({
    octokit,
    owner,
    ref,
    repo,
    sha,
  });

  try {
    return await action(temporaryRef);
  } finally {
    await deleteTemporaryRef();
  }
};

const getCommitsDetails = ({
  commit: {
    author,
    committer,
    message,
    tree: { sha: tree },
  },
  sha,
}: any) => ({
  author,
  committer,
  message,
  sha,
  tree,
});

const fetchCommitsDetails = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<CommitDetails[]> => {
  const options = octokit.pulls.listCommits.endpoint.merge({
    owner,
    pull_number: pullRequestNumber,
    repo,
  });
  const commits = await octokit.paginate(options);
  return commits.map(getCommitsDetails);
};

const fetchCommits = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<Sha[]> => {
  const details = await fetchCommitsDetails({
    octokit,
    owner,
    pullRequestNumber,
    repo,
  });
  return details.map(({ sha }) => sha);
};

export {
  CommitAuthor,
  CommitCommitter,
  CommitMessage,
  CommitDetails,
  PullRequestNumber,
  Ref,
  RepoName,
  RepoOwner,
  Sha,
  createRef,
  createTemporaryRef,
  deleteRef,
  fetchCommits,
  fetchCommitsDetails,
  fetchRefSha,
  generateUniqueRef,
  getHeadRef,
  updateRef,
  withTemporaryRef,
};

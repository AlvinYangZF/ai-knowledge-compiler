import { simpleGit } from "simple-git";

export interface CommitInfo {
  hash: string;
  date: string;
  message: string;
}

export async function initVault(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await ensureIdentity(dir);
  await git.add(".");
  const status = await git.status();
  if (status.files.length > 0) {
    await git.commit("akb: initialize vault");
  }
}

export async function commitFiles(
  dir: string,
  paths: string[],
  message: string,
): Promise<string> {
  const git = simpleGit(dir);
  await ensureIdentity(dir);
  await git.add(paths);
  const prefixed = message.startsWith("akb: ") ? message : `akb: ${message}`;
  const commit = await git.commit(prefixed);
  return commit.commit;
}

export async function getFileHistory(
  dir: string,
  path: string,
): Promise<CommitInfo[]> {
  const git = simpleGit(dir);
  const log = await git.log({ file: path });
  return log.all.map((entry) => ({
    hash: entry.hash,
    date: entry.date,
    message: entry.message,
  }));
}

export async function isClean(dir: string): Promise<boolean> {
  const status = await simpleGit(dir).status();
  return status.isClean();
}

async function ensureIdentity(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig("user.name", "akb");
  await git.addConfig("user.email", "akb@example.local");
}

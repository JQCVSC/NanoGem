import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitGitChanges,
  createGitBranch,
  getGitDiff,
  getGitStatus,
  revertGitWorkspace,
  validateBranchName,
} from "../src/git/gitReviewService.ts";

function runGitSync(cwd: string, args: string[]) {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

test("Git workflow handles non-Git workspaces safely without walking into parent repos", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-nongit-"));
  const parentRepo = path.join(tmpRoot, "parent_repo");
  const childNonGit = path.join(parentRepo, "nested_workspace");
  await fs.mkdir(childNonGit, { recursive: true });
  runGitSync(parentRepo, ["init"]);
  await fs.writeFile(path.join(childNonGit, "notes.txt"), "hello");

  try {
    const status = await getGitStatus(childNonGit);
    assert.equal(status.isGitRepo, false);
    assert.equal(status.clean, true);
    assert.deepEqual(status.entries, []);

    const diff = await getGitDiff(childNonGit);
    assert.equal(diff.isGitRepo, false);
    assert.equal(diff.diff, "");

    await assert.rejects(
      () => revertGitWorkspace(childNonGit, { confirm: true }),
      /not a Git repository/
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("Git workflow inspects clean & dirty repositories, validates branch names, and enforces confirmation on revert and commit", async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "nanogem-git-repo-"));
  try {
    runGitSync(repoDir, ["init", "-b", "main"]);
    runGitSync(repoDir, ["config", "user.name", "Tester"]);
    runGitSync(repoDir, ["config", "user.email", "tester@example.com"]);
    await fs.writeFile(path.join(repoDir, "app.txt"), "v1\n");
    runGitSync(repoDir, ["add", "app.txt"]);
    runGitSync(repoDir, ["commit", "-m", "initial"]);

    // Clean repository
    const cleanStatus = await getGitStatus(repoDir);
    assert.equal(cleanStatus.isGitRepo, true);
    assert.equal(cleanStatus.clean, true);
    assert.equal(cleanStatus.branch, "main");
    const cleanDiff = await getGitDiff(repoDir);
    assert.equal(cleanDiff.diff, "");

    // Dirty repository (modified + untracked)
    await fs.writeFile(path.join(repoDir, "app.txt"), "v2\n");
    await fs.writeFile(path.join(repoDir, "new.txt"), "brand new\n");

    const dirtyStatus = await getGitStatus(repoDir);
    assert.equal(dirtyStatus.clean, false);
    assert.equal(dirtyStatus.hasUncommittedChanges, true);
    assert.equal(dirtyStatus.entries.length, 2);

    const dirtyDiff = await getGitDiff(repoDir);
    assert.match(dirtyDiff.diff, /-v1/);
    assert.match(dirtyDiff.diff, /\+v2/);
    assert.deepEqual(dirtyDiff.untrackedFiles, ["new.txt"]);

    // Branch validation and creation
    assert.throws(() => validateBranchName("--help"), /Invalid branch name/);
    assert.throws(() => validateBranchName("feat..bad"), /Invalid branch name/);
    const branched = await createGitBranch(repoDir, "feature/review-test");
    assert.equal(branched.branch, "feature/review-test");

    // Revert without explicit confirmation fails
    await assert.rejects(
      () => revertGitWorkspace(repoDir, { confirm: false }),
      /Explicit confirmation/
    );
    assert.equal(await fs.readFile(path.join(repoDir, "app.txt"), "utf-8"), "v2\n");

    // Revert with explicit confirmation restores clean state
    const reverted = await revertGitWorkspace(repoDir, { confirm: true });
    assert.equal(reverted.reverted, true);
    assert.equal(reverted.status.clean, true);
    assert.equal(await fs.readFile(path.join(repoDir, "app.txt"), "utf-8"), "v1\n");
    await assert.rejects(fs.access(path.join(repoDir, "new.txt")));

    // Commit requires explicit confirmation
    await fs.writeFile(path.join(repoDir, "app.txt"), "v3\n");
    await assert.rejects(
      () => commitGitChanges(repoDir, { message: "should fail", confirm: false }),
      /Explicit confirmation/
    );

    const committed = await commitGitChanges(repoDir, {
      message: "update app to v3",
      confirm: true,
    });
    assert.ok(committed.commitHash);
    assert.equal(committed.status.clean, true);
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
});

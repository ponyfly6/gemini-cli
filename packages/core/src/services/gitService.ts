/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';
import { exec } from 'node:child_process';
import type { SimpleGit } from 'simple-git';      // simple-git 是一个 npm 包，它对 Git 命令行做了一层封装，可以在 Node.js 里以 JS/TS API 的方式操作 Git 仓库。
import { simpleGit, CheckRepoActions } from 'simple-git';
import type { Storage } from '../config/storage.js';

export class GitService {
  private projectRoot: string;
  private storage: Storage;

  constructor(projectRoot: string, storage: Storage) {
    this.projectRoot = path.resolve(projectRoot);
    this.storage = storage;
  }

  private getHistoryDir(): string {
    return this.storage.getHistoryDir();        // 拿到影子repo 的根目录 ~/.gemini/history/<hash>。
  }

  // 初始化：检测git 并建影子库
  async initialize(): Promise<void> {
    const gitAvailable = await this.verifyGitAvailability();
    if (!gitAvailable) {
      throw new Error(
        'Checkpointing is enabled, but Git is not installed. Please install Git or disable checkpointing to continue.',
      );
    }
    try {
      await this.setupShadowGitRepository();
    } catch (error) {
      throw new Error(
        `Failed to initialize checkpointing: ${error instanceof Error ? error.message : 'Unknown error'}. Please check that Git is working properly or disable checkpointing.`,
      );
    }
  }
  
  // 检测git是否可用
  verifyGitAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      exec('git --version', (error) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Creates a hidden git repository in the project root.
   * The Git repository is used to support checkpointing.
   */
  async setupShadowGitRepository() {
    const repoDir = this.getHistoryDir();
    const gitConfigPath = path.join(repoDir, '.gitconfig');

    await fs.mkdir(repoDir, { recursive: true });

    // We don't want to inherit the user's name, email, or gpg signing
    // preferences for the shadow repository, so we create a dedicated gitconfig.
    // 单独写一份 gitconfig，不继承用户的name / email / gpgsign 配置
    const gitConfigContent =
      '[user]\n  name = Gemini CLI\n  email = gemini-cli@google.com\n[commit]\n  gpgsign = false\n';
    await fs.writeFile(gitConfigPath, gitConfigContent);

    const repo = simpleGit(repoDir);
    const isRepoDefined = await repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);

    if (!isRepoDefined) {
      await repo.init(false, {
        '--initial-branch': 'main',
      });

      await repo.commit('Initial commit', { '--allow-empty': null });
    }

    // 同步用户项目的 .gitignore 到影子库
    const userGitIgnorePath = path.join(this.projectRoot, '.gitignore');
    const shadowGitIgnorePath = path.join(repoDir, '.gitignore');

    let userGitIgnoreContent = '';
    try {
      userGitIgnoreContent = await fs.readFile(userGitIgnorePath, 'utf-8');
    } catch (error) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.writeFile(shadowGitIgnorePath, userGitIgnoreContent);
  }

  // 影子仓库的句柄 getter ，所有git操作都是在影子库里记账，但作用的文件是项目目录，影子库与项目自己的 .git 完全隔离、互不干扰。
  // 句柄在cs里，句柄就是“某个资源的引用/控制权的代理”。
  private get shadowGitRepository(): SimpleGit {
    const repoDir = this.getHistoryDir();
    return simpleGit(this.projectRoot).env({
      GIT_DIR: path.join(repoDir, '.git'),
      GIT_WORK_TREE: this.projectRoot,
      // Prevent git from using the user's global git config.
      HOME: repoDir,
      XDG_CONFIG_HOME: repoDir,
    });
  }

  // 读当前快照（HEAD）  调用影子仓库句柄 → 实际运行 git rev-parse HEAD
  async getCurrentCommitHash(): Promise<string> {
    const hash = await this.shadowGitRepository.raw('rev-parse', 'HEAD');
    return hash.trim();       // 去掉前后空白符
  }

  async createFileSnapshot(message: string): Promise<string> {
    try {
      const repo = this.shadowGitRepository;
      await repo.add('.');      // git add .
      const commitResult = await repo.commit(message);      // 提交到影子仓库
      return commitResult.commit;     // commit hash
    } catch (error) {
      throw new Error(
        `Failed to create checkpoint snapshot: ${error instanceof Error ? error.message : 'Unknown error'}. Checkpointing may not be working properly.`,
      );
    }
  }

  // 从快照恢复 （回滚）
  async restoreProjectFromSnapshot(commitHash: string): Promise<void> {
    const repo = this.shadowGitRepository;
    await repo.raw(['restore', '--source', commitHash, '.']);     // git restore
    // Removes any untracked files that were introduced post snapshot.
    await repo.clean('f', ['-d']);      // git clean -fd  删除快照后新出现的 未跟踪文件/目录（比如你后来新建的 log/临时文件）。
  }
}

/**
 * Copyright (c) 2020 TypeFox GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { TerminalFrontendContribution } from '@theia/terminal/lib/browser/terminal-frontend-contribution';
import { IBaseTerminalServer } from '@theia/terminal/lib/common/base-terminal-protocol';
import { inject, injectable, postConstruct } from 'inversify';
import { GitpodTask, GitpodTaskServer, GitpodTaskState } from '../common/gitpod-task-protocol';
import { GitpodTerminalWidget } from './gitpod-terminal-widget';

interface GitpodTaskTerminalWidget extends GitpodTerminalWidget {
    readonly kind: 'gitpod-task'
    /** undefined if not running */
    remoteTerminal?: string
}
namespace GitpodTaskTerminalWidget {
    const idPrefix = 'gitpod-task-terminal'
    export function is(terminal: TerminalWidget): terminal is GitpodTaskTerminalWidget {
        return terminal.kind === 'gitpod-task';
    }
    export function toTerminalId(id: string): string {
        return idPrefix + ':' + id;
    }
    export function getTaskId(terminal: GitpodTaskTerminalWidget): string {
        return terminal.id.split(':')[1];
    }
}

@injectable()
export class GitpodTaskContribution implements FrontendApplicationContribution {

    @inject(TerminalFrontendContribution)
    private readonly terminals: TerminalFrontendContribution;

    @inject(GitpodTaskServer)
    private readonly server: GitpodTaskServer;

    private readonly taskTerminals = new Map<string, GitpodTaskTerminalWidget>();

    private readonly pendingInitialTasks = new Deferred<GitpodTask[]>();
    private readonly pendingInitializeLayout = new Deferred<void>();
    private updateQueue = this.pendingInitializeLayout.promise;

    @postConstruct()
    protected init(): void {
        // register client before connection is opened
        this.server.setClient({
            onDidChange: ({ updated }) => {
                this.pendingInitialTasks.resolve(updated);
                this.queue(() => this.updateTerminals(updated));
            }
        });
        this.terminals.onDidCreateTerminal(terminal => {
            if (GitpodTaskTerminalWidget.is(terminal)) {
                this.taskTerminals.set(terminal.id, terminal);
                terminal.onDidDispose(() =>
                    this.taskTerminals.delete(terminal.id)
                );
                terminal.onTerminalDidClose(() => {
                    if (terminal.remoteTerminal) {
                        fetch(window.location.protocol + '//' + window.location.host + '/_supervisor/v1/terminal/close/' + terminal.remoteTerminal, {
                            credentials: "include"
                        })
                    }
                });
            }
        });
    }

    async onDidInitializeLayout(): Promise<void> {
        const tasks = await this.pendingInitialTasks.promise;
        let ref: TerminalWidget | undefined;
        for (const task of tasks) {
            if (task.state == GitpodTaskState.CLOSED) {
                continue;
            }
            try {
                const id = GitpodTaskTerminalWidget.toTerminalId(task.id);
                let terminal = this.taskTerminals.get(id);
                if (!terminal) {
                    terminal = await this.terminals.newTerminal({
                        id,
                        kind: 'gitpod-task',
                        title: task.presentation!.name,
                        useServerTitle: false
                    }) as GitpodTaskTerminalWidget;
                    await terminal.start();
                    this.terminals.activateTerminal(terminal, {
                        ref,
                        area: task.presentation.openIn || 'bottom',
                        mode: task.presentation.openMode || 'tab-after'
                    });
                } else if (!IBaseTerminalServer.validateId(terminal.terminalId)) {
                    await terminal.start();
                }
                if (terminal) {
                    ref = terminal;
                }
            } catch (e) {
                console.error('Failed to start Gitpod task terminal:', e);
            }
        }
        this.pendingInitializeLayout.resolve();

        // if there is no terminal at all, lets start one
        if (!this.terminals.all.length) {
            const terminal = await this.terminals.newTerminal({});
            terminal.start();
            this.terminals.open(terminal);
        }
    }

    private async updateTerminals(tasks: GitpodTask[]): Promise<void> {
        for (const task of tasks) {
            try {
                const id = GitpodTaskTerminalWidget.toTerminalId(task.id);
                const terminal = this.taskTerminals.get(id);
                if (!terminal) {
                    continue;
                }
                if (task.state === GitpodTaskState.CLOSED) {
                    delete terminal.remoteTerminal;
                    terminal.dispose();
                    continue;
                }
                if (task.state !== GitpodTaskState.RUNNING) {
                    continue;
                }
                terminal.remoteTerminal = task.terminal;
                if (task.terminal) {
                    await this.server.attach({
                        terminalId: terminal.terminalId,
                        remoteTerminal: task.terminal
                    });
                }
            } catch (e) {
                console.error('Failed to update Gitpod task terminal:', e);
            }
        }
    }

    private queue(update: () => Promise<void>): Promise<void> {
        return this.updateQueue = this.updateQueue.then(update, update);
    }

}
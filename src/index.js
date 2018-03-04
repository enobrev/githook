"use strict";

    const os     = require('os');
    const fs     = require('fs');
    const http   = require('http');
    const exec   = require('child_process').exec;
    const crypto = require('crypto');
    const Slack  = require('slack-node');
    const LOG    = require('./Logger');
    const consul = require('consul')();
    const CONFIG = require('../.config.json');

    let oSlack = new Slack();
    oSlack.setWebhook(CONFIG.slack.webhook);

    let BUILDS = {};
    Object.keys(CONFIG.github.sources).forEach(sApp => {
        let oBuild = {
            app:  sApp,
            path: CONFIG.path.install[sApp]
        };

        if (oBuild.path) {
            const aSource     = CONFIG.github.sources[sApp].split('#');
            oBuild.repository = aSource[0];
            oBuild.branch     = `refs/heads/${aSource.length > 1 && aSource[1] && aSource[1].length ? aSource[1] : 'master'}`;

            BUILDS[oBuild.repository] = oBuild
        }
    });

    let handleHTTPRequest = function(oRequest, oResponse) {
        if (oRequest.url === '/health') {
            oResponse.writeHead(200);
            oResponse.end();
            return;
        }

        let oHeaders = oRequest.headers;
        let sMethod  = oRequest.method;
        let sUrl     = oRequest.url;
        let aBody    = [];

        if (oHeaders && oHeaders['x-github-event'] === 'push') {
            LOG.debug({action: 'githook.build.request', delivery: oHeaders['x-github-delivery'], method: sMethod, url: sUrl});

            oRequest.on('error', oError => {
                LOG.error({action: 'githook.build.request.error', error: {
                    name:    oError.name,
                    message: oError.message
                }});
            });

            oRequest.on('data', sChunk => {
                aBody.push(sChunk);
            });

            oRequest.on('end', () => {
                let oBody;
                try {
                    const sBody = Buffer.concat(aBody).toString();

                    if (!!oHeaders['x-hub-signature']) {
                        const sSigned = 'sha1=' + crypto.createHmac('sha1', CONFIG.github.secret).update(sBody).digest('hex');

                        if (sSigned !== oHeaders['x-hub-signature']) {
                            LOG.error({action: 'githook.build.signature.mismatch'});
                            return;
                        }
                    }

                    oBody = JSON.parse(sBody);

                    LOG.info({
                        action:     'githook.build.ready',
                        sender:     oBody.sender.login,
                        repository: oBody.repository.full_name,
                        commit:     oBody.head_commit.id,
                        message:    oBody.head_commit.message,
                        body:       oBody
                    });
                } catch (e) {
                    LOG.warn({
                        action:     'githook.build.start',
                        error:      {
                            name:    e.name,
                            message: e.message
                        }
                    });

                    return;
                }

                const oBuild = BUILDS[oBody.repository.full_name];

                if (!oBuild) {
                    LOG.warning({
                        action:     'githook.build.repository.not_defined',
                        repository: oBody.repository.full_name,
                    });

                    console.log(BUILDS);

                    return;
                }

                if (oBuild.branch !== oBody.ref) {
                    LOG.debug({
                        action:     'githook.build.repository.mismatched_branch',
                        repository: oBody.repository.full_name,
                        branch: {
                            commit: oBody.ref,
                            build:  oBuild.branch
                        }
                    });

                    return;
                }

                LOG.info({
                    action:  'githook.build.matched',
                    build:   oBuild
                });

                const sConsulKey = `repo/${oBuild.app}`;
                consul.kv.set(`repo/${oBuild.app}`, oBody.head_commit.id, (oError, oResult) => {
                    if (oError) {
                        LOG.warning({
                            action:  'githook.build.consul',
                            key:     sConsulKey,
                            value:   oBody.head_commit.id,
                            error:   oError
                        });
                    } else {
                        LOG.debug({
                            action: 'githook.build.consul',
                            key:    sConsulKey,
                            value:  oBody.head_commit.id,
                            result: oResult
                        });
                    }
                });

                const sCommand = `cd ${oBuild.path} && make githook`;

                LOG.info({
                    action:     'githook.build.command',
                    command:    sCommand
                });

                oSlack.webhook({
                    attachments: [
                        {
                            fallback:    `I started a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}> by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       `Build Started - ${oBody.head_commit.id.substring(0, 6) + '...'}`,
                            title_link:  oBody.head_commit.url,
                            author_name: oBody.sender.login,
                            author_link: oBody.sender.html_url,
                            author_icon: oBody.sender.avatar_url,
                            color:       '#666666',
                            text:        `> ${oBody.head_commit.message}`,
                            mrkdwn_in:   ["text"],
                            fields:      [
                                {
                                    title: 'Repository',
                                    value: `<${oBody.repository.html_url}|${oBody.repository.full_name}>`,
                                    short: true
                                },
                                {
                                    title: 'Commit',
                                    value: `<${oBody.head_commit.url}|${oBody.head_commit.id.substring(0, 15) + '...'}>`,
                                    short: true
                                }
                            ]
                        }
                    ]
                }, (err, response) => {});

                exec(sCommand, // command line argument directly in string
                    (error, stdout, stderr) => {      // one easy function to capture data/errors
                        let sFile = ['/tmp/githook', oBody.head_commit.id].join('-');
                        let aErrors = [];

                        if (stderr) {
                            aErrors = stderr.split("\n");
                            for (let i = aErrors.length - 1; i >= 0; i--) {
                                const sError = aErrors[i].toLowerCase().trim();
                                if (sError.length === 0
                                ||  sError.indexOf('warning') > -1
                                ||  sError.indexOf('parsequery') > -1) {
                                    aErrors.splice(i, 1);
                                }
                            }
                        }

                        if (aErrors.length > 0) {
                            sFile += '-err';
                            fs.writeFileSync(sFile, aErrors.join("\n"));

                            LOG.error({action: 'githook.build.std.error', log_file: sFile, output: aErrors});

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:   `I just finished a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}>.\n\n*StdError Output:*\n> ${aErrors.join("\n>")}`,
                                        title:      `Build Finished with stderr Output - ${oBody.head_commit.id.substring(0, 6) + '...'}`,
                                        title_link:  oBody.head_commit.url,
                                        author_name: oBody.sender.login,
                                        author_link: oBody.sender.html_url,
                                        author_icon: oBody.sender.avatar_url,
                                        color:       'warning',
                                        text:        `> ${aErrors.join("\n>")}`,
                                        mrkdwn_in:   ["text"],
                                        fields:     [
                                            {
                                                title: 'Repository',
                                                value: `<${oBody.repository.html_url}|${oBody.repository.full_name}>`,
                                                short: true
                                            },
                                            {
                                                title: 'Commit',
                                                value: `<${oBody.head_commit.url}|${oBody.head_commit.id.substring(0, 15) + '...'}>`,
                                                short: true
                                            }
                                        ]
                                    }
                                ]
                            }, (err, response) => {});

                        } else if (error) {
                            LOG.error({action: 'githook.build.exec.error', output: error});

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:    `I failed a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}>.\n>*Error:*\n> ${error.message}`,
                                        title:       `Build Failed - ${oBody.head_commit.id.substring(0, 6) + '...'}`,
                                        title_link:  oBody.head_commit.url,
                                        author_name: oBody.sender.login,
                                        author_link: oBody.sender.html_url,
                                        author_icon: oBody.sender.avatar_url,
                                        color:       'danger',
                                        text:        `> ${error.message}`,
                                        mrkdwn_in:   ["text"],
                                        fields:     [
                                            {
                                                title: 'Repository',
                                                value: `<${oBody.repository.html_url}|${oBody.repository.full_name}>`,
                                                short: true
                                            },
                                            {
                                                title: 'Commit',
                                                value: `<${oBody.head_commit.url}|${oBody.head_commit.id.substring(0, 15) + '...'}>`,
                                                short: true
                                            }
                                        ]
                                    }
                                ]
                            }, (err, response) => {});
                        } else {
                            sFile += '-ok';
                            fs.writeFileSync(sFile, stdout);

                            LOG.info({
                                action:     'githook.build.done',
                                sender:     oBody.sender.login,
                                repository: oBody.repository.full_name,
                                commit:     oBody.head_commit.id,
                                message:    oBody.head_commit.message,
                                log_file:   sFile
                            });

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:    `I finished a Build for repo <${oBody.repository.html_url}|${oBody.repository.full_name}>, commit <${oBody.head_commit.url}|${oBody.head_commit.id}> by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                                        title:       `Build Complete - ${oBody.head_commit.id.substring(0, 6) + '...'}`,
                                        title_link:  oBody.head_commit.url,
                                        author_name: oBody.sender.login,
                                        author_link: oBody.sender.html_url,
                                        author_icon: oBody.sender.avatar_url,
                                        color:       'good',
                                        text:        `> ${oBody.head_commit.message}`,
                                        mrkdwn_in:   ["text"],
                                        fields:     [
                                            {
                                                title: 'Repository',
                                                value: `<${oBody.repository.html_url}|${oBody.repository.full_name}>`,
                                                short: true
                                            },
                                            {
                                                title: 'Commit',
                                                value: `<${oBody.head_commit.url}|${oBody.head_commit.id.substring(0, 15) + '...'}>`,
                                                short: true
                                            }
                                        ]
                                    }
                                ]
                            }, (err, response) => {});
                        }

                    });
            });
        } else if (oHeaders && oHeaders['x-github-event'] === 'ping') {
            LOG.info({action: 'githook.build.request.ping', method: sMethod, url: sUrl});
        } else if (sUrl === '/') {
            oResponse.writeHead(200, {'Content-Type': 'text/plain'});
            oResponse.write('ARRRG');
            oResponse.end();
            return;
        } else {
            LOG.warning({action: 'githook.build.request.weird', method: sMethod, url: sUrl});
        }

        oResponse.writeHead(202, {'Content-Type': 'text/plain'});
        oResponse.end();
    };

    http.createServer(handleHTTPRequest).listen(CONFIG.server.port);

    let ping = () => {
        LOG.info({
            action:    'githook.ping',
            hostname:   os.hostname(),
            pid:        process.pid,
            port:       CONFIG.server.port
        });
    };

    ping();
    setInterval(ping, CONFIG.server.ping);

    LOG.notice({action: 'githook.init'});

    oSlack.webhook({
        text:  "Hello! I'm here and waiting for github updates."
    }, (err, response) => {});

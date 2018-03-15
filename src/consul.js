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
    oSlack.setWebhook(CONFIG.slack.webhook.githook);

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

                const aMessage       = oBody.commits.map(oCommit => `> <${oCommit.url}|${oCommit.id.substring(0, 6)}>: ${oCommit.message}`);
                const aLogMessage    = oBody.commits.map(oCommit => oCommit.message);
                const sRepo          = `<${oBody.repository.html_url}|${oBody.repository.full_name}>`;
                const sCompareHashes = oBody.compare.split('/').pop();
                const sCompare       = `<${oBody.compare}|${sCompareHashes}>`;
                const sConsulKey     = `repo/${oBuild.app}`;
                const aFields        = [
                    {
                        title: 'Repository',
                        value: sRepo,
                        short: true
                    },
                    {
                        title: 'Commits',
                        value: sCompare,
                        short: true
                    },
                    {
                        title: 'Domain',
                        value: CONFIG.uri.domain,
                        short: true
                    }
                ];


                oSlack.webhook({
                    attachments: [
                        {
                            fallback:    `${CONFIG.uri.domain}: I started a Build for repo ${sRepo}, commit ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       `${CONFIG.uri.domain}: Build Started - ${sCompareHashes}`,
                            title_link:  oBody.compare,
                            author_name: oBody.sender.login,
                            author_link: oBody.sender.html_url,
                            author_icon: oBody.sender.avatar_url,
                            color:       '#666666',
                            text:        aMessage.join("\n"),
                            mrkdwn_in:   ["text"],
                            fields:      aFields
                        }
                    ]
                }, (err, response) => {});

                consul.kv.set(`repo/${oBuild.app}`, sCompareHashes, (oError, oResult) => {
                    if (oError) {
                        LOG.warning({
                            action:  'githook.build.consul',
                            key:     sConsulKey,
                            value:   sCompareHashes,
                            error:   oError
                        });

                        oSlack.webhook({
                            attachments: [
                                {
                                    fallback:    `${CONFIG.uri.domain}: I had trouble starting a Build for repo ${sRepo}.\n>*Error:*\n> ${error.message}`,
                                    title:       `${CONFIG.uri.domain}: Build Failed - ${sCompareHashes}`,
                                    title_link:  oBody.compare,
                                    author_name: oBody.sender.login,
                                    author_link: oBody.sender.html_url,
                                    author_icon: oBody.sender.avatar_url,
                                    color:       'danger',
                                    text:        `> ${error.message}`,
                                    mrkdwn_in:   ["text"],
                                    fields:      aFields
                                }
                            ]
                        }, (err, response) => {});
                    } else {
                        LOG.debug({
                            action: 'githook.build.consul',
                            key:    sConsulKey,
                            value:  sCompareHashes,
                            result: oResult
                        });

                        oSlack.webhook({
                            attachments: [
                                {
                                    fallback:    `${CONFIG.uri.domain}: I _think_ I finished a Build for repo ${sRepo}, commits ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                                    title:       `${CONFIG.uri.domain}: Build Complete - ${sCompareHashes}`,
                                    title_link:  oBody.compare,
                                    color:       'good',
                                    mrkdwn_in:   ["text"],
                                    fields:      aFields
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
        text:  "Hello! I'm here and waiting for github updates. to\n * " + Object.values(CONFIG.github.sources).join("\n * ")
    }, (err, response) => {});

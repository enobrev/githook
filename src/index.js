"use strict";

    const fs       = require('fs');
    const http     = require('http');
    const exec     = require('child_process').exec;
    const crypto   = require('crypto');
    const Slack    = require('slack-node');
    const {Logger} = require('enobrev-node-tools');

    const sConfigPath = '/etc/welco/config.githook.json';

    let CONFIG;
    let oSlack = new Slack();
    let BUILDS = {};

    const GithookLogger = new Logger({
        service: 'GithookMake',
        console: false,
        syslog:  true
    });

    const preInit = () => {
        fs.access(sConfigPath, fs.constants.R_OK, oError => {
            if (oError) {
                GithookLogger.w('config.not_available');
                setTimeout(preInit, 1000);
            } else {
                GithookLogger.w('config.ready');
                CONFIG = require(sConfigPath);
                init();
            }
        });
    };

    preInit();

    process.on('SIGHUP', () => {
        GithookLogger.d('config.sighup.reload');
        delete require.cache[sConfigPath];
        config();
    });

    const handleHTTPRequest = function(oRequest, oResponse) {
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
            GithookLogger.d('githook.build.request', {delivery: oHeaders['x-github-delivery'], method: sMethod, url: sUrl});

            oRequest.on('error', oError => {
                GithookLogger.e('githook.build.request.error', {
                    error: {
                        name:    oError.name,
                        message: oError.message
                    }
                });
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
                            GithookLogger.e('githook.build.signature.mismatch');
                            return;
                        }
                    }

                    oBody = JSON.parse(sBody);

                    GithookLogger.i('githook.build.ready', {
                        sender:     oBody.sender.login,
                        repository: oBody.repository.full_name,
                        commit:     oBody.head_commit.id,
                        message:    oBody.head_commit.message,
                        body:       oBody
                    });
                } catch (e) {
                    GithookLogger.w('githook.build.start', {
                        error:      {
                            name:    e.name,
                            message: e.message
                        }
                    });

                    return;
                }

                const oBuild = BUILDS[oBody.repository.full_name];

                if (!oBuild) {
                    GithookLogger.w('githook.build.repository.not_defined', {
                        repository: oBody.repository.full_name,
                    });

                    console.log(BUILDS);

                    return;
                }

                if (oBuild.branch !== oBody.ref) {
                    GithookLogger.d('githook.build.repository.mismatched_branch', {
                        repository: oBody.repository.full_name,
                        branch: {
                            commit: oBody.ref,
                            build:  oBuild.branch
                        }
                    });

                    return;
                }

                GithookLogger.i('githook.build.matched', {
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

                const sCommand = `cd ${oBuild.path} && make githook`;

                GithookLogger.i('githook.build.command', {
                    command:    sCommand
                });

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

                            GithookLogger.e('githook.build.std.error', {log_file: sFile, output: aErrors});

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:   `${CONFIG.uri.domain}: I just finished a Build for repo ${sRepo} with stderr Output\n\n*StdError Output:*\n> ${aErrors.join("\n>")}`,
                                        title:      `${CONFIG.uri.domain}: Build Finished with stderr Output - ${sCompareHashes}`,
                                        title_link:  oBody.compare,
                                        author_name: oBody.sender.login,
                                        author_link: oBody.sender.html_url,
                                        author_icon: oBody.sender.avatar_url,
                                        color:       'warning',
                                        text:        `> ${aErrors.join("\n>")}`,
                                        mrkdwn_in:   ["text"],
                                        fields:      aFields
                                    }
                                ]
                            }, (err, response) => {});

                        } else if (error) {
                            GithookLogger.e('githook.build.exec.error', {output: error});

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:    `${CONFIG.uri.domain}: I failed a Build for repo ${sRepo}.\n>*Error:*\n> ${error.message}`,
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
                            sFile += '-ok';
                            fs.writeFileSync(sFile, stdout);

                            GithookLogger.i('githook.build.done', {
                                sender:     oBody.sender.login,
                                repository: oBody.repository.full_name,
                                commit:     sCompareHashes,
                                message:    aLogMessage.join('\n'),
                                log_file:   sFile
                            });

                            oSlack.webhook({
                                attachments: [
                                    {
                                        fallback:    `${CONFIG.uri.domain}: I finished a Build for repo ${sRepo}, commits ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
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
            GithookLogger.i('githook.build.request.ping', {method: sMethod, url: sUrl});
        } else if (sUrl === '/') {
            oResponse.writeHead(200, {'Content-Type': 'text/plain'});
            oResponse.write('ARRRG');
            oResponse.end();
            return;
        } else {
            GithookLogger.w('githook.build.request.weird', {method: sMethod, url: sUrl});
        }

        oResponse.writeHead(202, {'Content-Type': 'text/plain'});
        oResponse.end();
    };

    const config = function() {
        BUILDS = {};
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

        oSlack.setWebhook(CONFIG.slack.webhook.githook);
        oSlack.webhook({
            text:  `Hello ${CONFIG.uri.domain}! I'm here and waiting for github updates. to\n * ${Object.values(CONFIG.github.sources).join("\n * ")}`
        }, (err, response) => {
            GithookLogger.d('githook.slack.greeted');
        });

        GithookLogger.n('githook.configured');
    };

    let bInitOnce = false;

    const init = function() {
        if (bInitOnce) {
            return;
        }

        bInitOnce = true;

        config();
        http.createServer(handleHTTPRequest).listen(CONFIG.server.port);
        GithookLogger.n('githook.init');
    };

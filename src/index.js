"use strict";

    const fs       = require('fs');
    const path     = require('path');
    const http     = require('http');
    const AWS      = require('aws-sdk');
    const AWS_PS   = require('aws-parameter-store').default;
    const exec     = require('child_process').exec;
    const crypto   = require('crypto');
    const async    = require('async');
    const Slack    = require('slack-node');
    const {Logger} = require('winston-rsyslog-cee');

    const sConfigPath = '/etc/welco/config.githook.json';

    let CONFIG;
    let oSlack = new Slack();
    let BUILDS = {};
    let S3;

    const GithookLogger = new Logger({
        service: 'Githook',
        console: false,
        syslog:  true
    });

    const loadConfig = () => {
        fs.access(sConfigPath, fs.constants.R_OK, oError => {
            if (oError) {
                GithookLogger.w('config.not_available');
                setTimeout(loadConfig, 1000);
            } else {
                GithookLogger.d('config.ready');
                CONFIG = require(sConfigPath);
                config();
            }
        });
    };
    
    loadConfig();

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

        const oLogger  = new Logger({
            service: 'Githook',
            console: false,
            syslog:  true
        });

        let oHeaders = oRequest.headers;
        let sMethod  = oRequest.method;
        let sUrl     = oRequest.url;
        let aBody    = [];

        if (oHeaders && oHeaders['x-github-event'] === 'push') {
            oLogger.d('request', {delivery: oHeaders['x-github-delivery'], method: sMethod, url: sUrl});

            oRequest.on('error', oError => {
                oLogger.e('request.error', {
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
                            oLogger.e('signature.mismatch');
                            return;
                        }
                    }

                    oBody = JSON.parse(sBody);

                    oLogger.i('ready', {
                        sender:     oBody.sender.login,
                        repository: oBody.repository.full_name,
                        commit:     oBody.head_commit.id,
                        message:    oBody.head_commit.message,
                        body:       oBody
                    });
                } catch (e) {
                    oLogger.w('start', {
                        error:      {
                            name:    e.name,
                            message: e.message
                        }
                    });

                    return;
                }

                oLogger.setPurpose(oBody.repository.full_name);
                
                const oBuild = BUILDS[oBody.repository.full_name];

                if (!oBuild) {
                    oLogger.w('repository.not_defined', {
                        repository: oBody.repository.full_name,
                    });

                    return;
                }

                if (oBuild.branch_ref !== oBody.ref) {
                    oLogger.d('repository.mismatched_branch', {
                        repository: oBody.repository.full_name,
                        branch: {
                            commit: oBody.ref,
                            build:  oBuild.branch_ref
                        }
                    });

                    return;
                }

                oLogger.i('matched', {
                    build:   oBuild
                });

                const aMessage       = oBody.commits.map(oCommit => `<${oCommit.url}|${oCommit.id.substring(0, 6)}>: ${oCommit.message}`);
                const sRepo          = `<${oBody.repository.html_url}|${oBody.repository.full_name}>`;
                const sCompareHashes = oBody.compare.split('/').pop();
                const sCompare       = `<${oBody.compare}|${sCompareHashes}>`;

                oSlack.webhook({
                    attachments: [
                        {
                            fallback:    `${CONFIG.uri.domain}: I started a Build for repo ${sRepo}, commit ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       "Build Started",
                            title_link:  oBody.compare,
                            author_name: oBody.sender.login,
                            author_link: oBody.sender.html_url,
                            author_icon: oBody.sender.avatar_url,
                            color:       '#666666',
                            text:        `${CONFIG.uri.domain} - ${sRepo} - ${sCompare}`,
                            mrkdwn_in:   ["text"]
                        },
                        {
                            text:        aMessage.join("\n"),
                            mrkdwn_in:   ["text"]
                        }
                    ]
                }, (err, response) => {});


                const sFile       = `${oBody.head_commit.id}.tgz`;
                const sOutputFile = path.join(CONFIG.path.cache, sFile);
                const sReleaseKey = path.join(CONFIG.aws.path_release, oBuild.app, sFile);
                const sReleaseURI = `https://${CONFIG.aws.hostname}/${CONFIG.aws.bucket_release}/${sReleaseKey}`;

                const TimedCommand = (sAction, sCommand, fCallback) => {
                    const oTimer = oLogger.startTimer(sAction);
                    exec(sCommand, (oError, sStdOut, sStdError) => {
                        oLogger.dt(oTimer);
                        fCallback(oError, {command: sCommand, stdout: sStdOut, stderr: sStdError});
                    })
                };

                const oActions = {
                    reset:                       cb  => TimedCommand('reset',     `cd ${oBuild.path} && git reset --hard HEAD --quiet`,             cb),
                    checkout:  ['reset',     (_, cb) => TimedCommand('checkout',  `cd ${oBuild.path} && git checkout ${oBuild.branch} --quiet`,     cb)],
                    pull:      ['checkout',  (_, cb) => TimedCommand('pull',      `cd ${oBuild.path} && git pull --quiet`,                          cb)],
                    make:      ['pull',      (_, cb) => TimedCommand('make',      `cd ${oBuild.path} && make githook2`,                             cb)],
                    tar:       ['make',      (_, cb) => TimedCommand('tar',       `tar --exclude=${sFile} -czf ${sOutputFile} -C ${oBuild.path} .`, cb)]
                };

                oActions.upload = ['tar',  (_, fCallback) => {
                    const oTimer = oLogger.startTimer('upload');

                    S3.upload({
                        Bucket:         CONFIG.aws.bucket_release,
                        Key:            sReleaseKey,
                        Body:           fs.readFileSync(sOutputFile),
                        ACL:            'private',
                        ContentType:    'application/gzip'
                    }, (oError, oResponse) => {
                        oLogger.dt(oTimer, {url: sReleaseURI});
                        fCallback(oError, oResponse);
                    });
                }];

                oActions.parameter_store = ['upload', (_, fCallback) => {
                    const oTimer     = oLogger.startTimer('parameter_store');
                    const bOverwrite = true;

                    AWS_PS.put(`/${CONFIG.environment}/${oBuild.app}/release`, oBody.head_commit.id, AWS_PS.TYPE_STRING, bOverwrite, (oError, oResponse) => {
                        oLogger.dt(oTimer);
                        fCallback(oError, oResponse);
                    });
                }];

                async.auto(oActions, (oError, oResults) => {
                    if (oError) {
                        oLogger.e('error', {output: oError, build: JSON.stringify(oResults)});

                        oSlack.webhook({
                            attachments: [
                                {
                                    fallback:    `${CONFIG.uri.domain}: I failed a Build for repo ${sRepo}.\n>*Error:*\n> ${oError.message}`,
                                    title:       `${CONFIG.uri.domain} - ${sRepo} - ${sCompareHashes} - Build Failed`,
                                    title_link:  oBody.compare,
                                    author_name: oBody.sender.login,
                                    author_link: oBody.sender.html_url,
                                    author_icon: oBody.sender.avatar_url,
                                    color:       'danger',
                                    text:        `> ${oError.message}`,
                                    mrkdwn_in:   ["text"]
                                }
                            ]
                        }, (oSlackError, oSlackResponse) => {});
                        return;
                    }

                    const aStdError = Object.values(oResults)
                                            .filter(oResult => oResult.stderr && oResult.stderr.length > 0)
                                            .map(oResult => `$ ${oResult.command}\n${oResult.stdout.trim()}\n${oResult.stderr.trim()}`);

                    oLogger.d('complete', {commit: oBody.head_commit.id, build: JSON.stringify(oResults)});

                    let aAttachments = [
                        {
                            fallback:    `${CONFIG.uri.domain}: I finished a Build for repo ${sRepo}, commits ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       `Build Complete`,
                            title_link:  oBody.compare,
                            color:       'good',
                            text:        `${CONFIG.uri.domain} - ${sRepo} - ${sCompare}`,
                        }
                    ];

                    if (aStdError && aStdError.length > 0) {
                        aAttachments[0].title = "Build Complete, with stderr output";
                        aAttachments[0].color = 'warning';
                        aAttachments.push(
                            {
                                text:  "```" + aStdError.join('\n') + "```"
                            }
                        )
                    }

                    oSlack.webhook({
                        attachments: aAttachments
                    }, (err, response) => {});

                    oLogger.d('notified');
                    oLogger.summary();
                });
            });

            oResponse.writeHead(202, {'Content-Type': 'text/plain'});
            oResponse.end();
        } else if (oHeaders && oHeaders['x-github-event'] === 'ping') {
            oLogger.i('request.ping', {method: sMethod, url: sUrl});

            oResponse.writeHead(202, {'Content-Type': 'text/plain'});
            oResponse.end();

            oLogger.summary();
        } else if (sUrl === '/') {
            oResponse.writeHead(200, {'Content-Type': 'text/plain'});
            oResponse.write('ARRRG');
            oResponse.end();

            oLogger.summary();
        } else {
            oResponse.writeHead(202, {'Content-Type': 'text/plain'});
            oResponse.end();

            oLogger.w('request.weird', {method: sMethod, url: sUrl});
            oLogger.summary();
        }

    };

    const config = fConfigured => {
        async.parallel([
            fCallback => {
                BUILDS = {};

                Object.keys(CONFIG.github.sources).forEach(sApp => {
                    let oBuild = {
                        app:  sApp
                    };

                    const aParsed = CONFIG.github.sources[sApp].match(/([^\/]+)\/([^#]+)(#(.+))?/);
                    if (aParsed) {
                        const sOwner  = aParsed[1];
                        const sRepo   = aParsed[2];
                        const sBranch = aParsed[4];
                        const sPath   = path.join(CONFIG.path.build, sRepo);

                        oBuild.repository = `${sOwner}/${sRepo}`;
                        oBuild.branch     = sBranch ? sBranch : 'master';
                        oBuild.branch_ref = `refs/heads/${sBranch ? sBranch : 'master'}`;
                        oBuild.path       = sPath;

                        BUILDS[oBuild.repository] = oBuild
                    }
                });

                fCallback();
            },
            fCallback => {
                const sMessage = `Hello ${CONFIG.uri.domain}! I'm here and waiting for github updates. to\n * ${Object.values(CONFIG.github.sources).join("\n * ")}`;
                oSlack.setWebhook(CONFIG.slack.webhook.githook);
                oSlack.webhook({
                    text: sMessage
                }, (err, response) => {
                    GithookLogger.d('slack.greeted', {slack: CONFIG.slack.webhook.githook, message: sMessage});
                    fCallback();
                });
            },
            fCallback => {
                fs.access(CONFIG.path.cache, fs.constants.W_OK, oError => {
                    if (oError) {
                        fs.mkdir(CONFIG.path.cache, 0o777, fCallback)
                    } else {
                        fCallback()
                    }
                });
            }
        ], () => {
            AWS_PS.setRegion(CONFIG.aws.region);

            S3 = new AWS.S3({
                region: CONFIG.aws.region
            });

            GithookLogger.n('configured');

            initOnce();

            if (typeof fConfigured === 'function') {
                fConfigured();
            }
        });
    };

    let bInitOnce = false;

    const initOnce = () => {
        if (bInitOnce) {
            return;
        }

        bInitOnce = true;

        http.createServer(handleHTTPRequest).listen(CONFIG.server.port);

        GithookLogger.summary('Init');
    };

"use strict";

    const fs                  = require('fs');
    const path                = require('path');
    const http                = require('http');
    const AWS                 = require('aws-sdk');
    const consul              = require('consul')();
    const AWS_PS              = require('aws-parameter-store').default;
    const exec                = require('child_process').exec;
    const dateFormat          = require('date-fns/format');
    const crypto              = require('crypto');
    const async               = require('async');
    const { IncomingWebhook } = require('@slack/client');
    const { Logger }          = require('rsyslog-cee');

    const sConfigPath = '/etc/welco/config.githook.json';

    let CONFIG;
    let BUILDS = {};
    let S3;
    let oSlack;

    const GithookLogger = new Logger({
        service: 'Githook',
        console: false,
        syslog:  true
    });

    const loadConfig = () => {
        fs.access(sConfigPath, fs.constants.R_OK, oError => {
            if (oError) {
                GithookLogger.w('Githook.config.not_available');
                setTimeout(loadConfig, 1000);
            } else {
                GithookLogger.d('Githook.config.ready');
                CONFIG = require(sConfigPath);
                config();
            }
        });
    };
    
    loadConfig();

    process.on('SIGHUP', () => {
        GithookLogger.d('Githook.config.sighup.reload');
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
            oLogger.d('Githook.http_request', {delivery: oHeaders['x-github-delivery'], method: sMethod, url: sUrl});

            oRequest.on('error', oError => {
                oResponse.writeHead(500, {'Content-Type': 'text/plain'});
                oResponse.end();

                oLogger.e('Githook.http_request.error', {
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
                oResponse.writeHead(202, {'Content-Type': 'text/plain'});
                oResponse.end();

                let oBody;
                try {
                    const sBody = Buffer.concat(aBody).toString();

                    if (!!oHeaders['x-hub-signature']) {
                        const sSigned = 'sha1=' + crypto.createHmac('sha1', CONFIG.github.secret).update(sBody).digest('hex');

                        if (sSigned !== oHeaders['x-hub-signature']) {
                            oLogger.e('Githook.signature.mismatch');
                            return;
                        }
                    }

                    oBody = JSON.parse(sBody);

                    oLogger.i('Githook.ready', {
                        repository: oBody.repository.full_name,
                        commit:     oBody.head_commit.id
                    });
                } catch (e) {
                    oLogger.w('Githook.start', {
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
                    oLogger.w('Githook.repository.not_defined', {
                        repository: oBody.repository.full_name,
                    });

                    return;
                }

                const bIsBuild = oBody.ref.indexOf('refs/heads') === 0;
                if (!bIsBuild) {
                    oLogger.d('Githook.not_a_build', {
                        repository: oBody.repository.full_name,
                        branch: {
                            commit: oBody.ref,
                            build:  oBuild.branch_ref
                        }
                    });

                    return;
                }

                oLogger.i('Githook.matched', {
                    build: JSON.stringify(oBuild)
                });

                const sRequestBranch    = oBody.ref.replace(/^refs\/heads\//, '');
                const bIsReleaseBranch  = oBuild.branch === sRequestBranch;
                const aMessage          = oBody.commits.map(oCommit => `<${oCommit.url}|${oCommit.id.substring(0, 6)}>: ${oCommit.message}`);
                const sRepo             = `<${oBody.repository.html_url}|${oBody.repository.full_name}>`;
                const sCompareHashes    = oBody.compare.split('/').pop();
                const sCompare          = `<${oBody.compare}|${sCompareHashes}>`;
                const sLogs             = `<https://kibana.${CONFIG.uri.domain}/app/kibana#/discover?_g=(filters:!(),refreshInterval:(display:Off,pause:!f,value:0),time:(from:now-1h,mode:quick,to:now))&_a=(columns:!('--i',severity,'--action','--ms'),interval:auto,query:(language:lucene,query:'%5C-%5C-t:${oLogger.thread_hash}'),sort:!('--i',asc))|Kibana>`;

                let sTitle = bIsReleaseBranch
                    ? `Build Started for Auto-Release branch [${sRequestBranch}]`
                    : `Build Started for branch [${sRequestBranch}]`;

                oSlack.send({
                    attachments: [
                        {
                            fallback:    `${CONFIG.uri.domain}: ${sTitle} for repo ${sRepo}, commit ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       sTitle,
                            title_link:  oBody.compare,
                            author_name: oBody.sender.login,
                            author_link: oBody.sender.html_url,
                            author_icon: oBody.sender.avatar_url,
                            color:       '#666666',
                            text:        `${CONFIG.uri.domain} - ${sRepo} - ${sCompare}`,
                            mrkdwn_in:   ["text", "title"]
                        },
                        {
                            text:        aMessage.join("\n"),
                            mrkdwn_in:   ["text"]
                        }
                    ]
                }, (err, response) => {});


                const sBranchString     = sRequestBranch.replace(/[^/a-zA-Z0-9_-]/, '');
                const sFile             = `${oBody.head_commit.id}.tgz`;
                const sOutputFile       = path.join(CONFIG.path.cache, sFile);
                const sReleaseKey       = path.join(CONFIG.aws.path_release, oBuild.app, sFile);
                const sReleaseURI       = `https://${CONFIG.aws.hostname}/${CONFIG.aws.bucket_release}/${sReleaseKey}`;
                const sTag              = `build/${sBranchString}/${dateFormat(new Date(), 'YYYY-MM-DD_HH-mm-ss')}`;
                const sRelease          = `<${sReleaseURI}|${sTag}>`;
                const sSSHUrl           = oBody.repository.ssh_url.replace('git@github.com', oBuild.ssh);
                const sBuildPath        = path.join(CONFIG.path.build, oBody.head_commit.id);

                const TimedCommand = (sAction, sCommand, fCallback) => {
                    const oTimer = oLogger.startTimer(`Githook.${sAction}`);
                    exec(sCommand, (oError, sStdOut, sStdError) => {
                        oLogger.dt(oTimer);
                        fCallback(oError, {command: sCommand, stdout: sStdOut, stderr: sStdError});
                    })
                };

                const oActions = {
                    prep:                        cb  => TimedCommand('prep',      `rm -rf ${sBuildPath}`,                                                  cb),
                    clone:     ['prep',      (_, cb) => TimedCommand('clone',     `cd ${CONFIG.path.build} && git clone ${sSSHUrl} ${sBuildPath} --quiet`, cb)],
                    checkout:  ['clone',     (_, cb) => TimedCommand('checkout',  `cd ${sBuildPath} && git checkout ${sRequestBranch} --quiet`,             cb)],
                    reset:     ['checkout',  (_, cb) => TimedCommand('reset',     `cd ${sBuildPath} && git reset --hard ${oBody.head_commit.id} --quiet`,  cb)]
                };

                oActions.make   = ['reset', (_, fCallback) => {
                    TimedCommand('make', `cd ${sBuildPath} && make githook`, (oError, oResult) => {
                        if (oResult.stderr && oResult.stderr.length > 0) {
                            oResult.stderr = oResult.stderr.split('\n').filter(sError => sError.indexOf('peer dependency') === -1).join("\n");  // Yarn adds peer dependency warnings to stderr for some incomprehensible reason - even in silent mode - see https://github.com/yarnpkg/yarn/issues/4064
                        }

                        fCallback(oError, oResult);
                    })
                }];

                oActions.tar    = ['make', (_, fCallback) => TimedCommand('tar', `tar --exclude=${sFile} -czf ${sOutputFile} -C ${sBuildPath} .`, fCallback)];

                oActions.upload = ['tar',  (_, fCallback) => {
                    const oTimer = oLogger.startTimer('Githook.upload');

                    S3.upload({
                        Bucket:         CONFIG.aws.bucket_release,
                        Key:            sReleaseKey,
                        Body:           fs.readFileSync(sOutputFile),
                        ACL:            'private',
                        ContentType:    'application/gzip'
                    }, (oError, oResponse) => {
                        oLogger.dt(oTimer);
                        fCallback(oError, oResponse);
                    });
                }];

                if (bIsReleaseBranch) {
                    oLogger.d('Githook.release', {
                        repository: oBody.repository.full_name,
                        branch: {
                            commit: oBody.ref,
                            build:  oBuild.branch_ref
                        }
                    });

                    oActions.consul = ['upload', (_, fCallback) => {
                        const oTimer = oLogger.startTimer('Githook.consul');
                        consul.kv.set(`${oBuild.app}/release`, oBody.head_commit.id, (oError, oResult) => {
                            oLogger.dt(oTimer);
                            fCallback(oError, oResult);
                        });
                    }];

                    oActions.parameter_store = ['upload', (_, fCallback) => {
                        const oTimer     = oLogger.startTimer('Githook.parameter_store');
                        const bOverwrite = true;

                        AWS_PS.put(`/${CONFIG.environment}/${oBuild.app}/release`, oBody.head_commit.id, AWS_PS.TYPE_STRING, bOverwrite, (oError, oResponse) => {
                            oLogger.dt(oTimer);
                            fCallback(oError, oResponse);
                        });
                    }];
                }

                oActions.cleanTmp = ['upload', (_, cb) => TimedCommand('cleanTmp',   `rm -rf ${sOutputFile}`,                                               cb)];
                oActions.tag      = ['upload', (_, cb) => TimedCommand('tag',        `cd ${sBuildPath} && git tag --force ${sTag} ${oBody.head_commit.id}`, cb)];
                oActions.push     = ['tag',    (_, cb) => TimedCommand('push',       `cd ${sBuildPath} && git push --tags --quiet --force`,                 cb)];
                oActions.clean    = ['push',   (_, cb) => TimedCommand('cleanBuild', `rm -rf ${sBuildPath}`,                                                cb)];

                async.auto(oActions, (oError, oResults) => {
                    if (oError) {
                        oLogger.e('Githook.async', {error: oError, build: JSON.stringify(oResults)});

                        oSlack.send({
                            icon_emoji:  ":bangbang:",
                            attachments: [
                                {
                                    fallback:    `${CONFIG.uri.domain}: I failed a Build for repo ${sRepo}.\n>*Error:*\n> ${oError.message}`,
                                    author_name: oBody.sender.login,
                                    author_link: oBody.sender.html_url,
                                    author_icon: oBody.sender.avatar_url,
                                    color:       'danger',
                                    text:        `<!here> Build Failed: ${CONFIG.uri.domain} - ${sRepo} - ${sCompare} - ${sLogs}`,
                                    mrkdwn_in:   ["text"]
                                },
                                {
                                    text:        "```\n" + oError.message + "\n```",
                                    mrkdwn_in:   ["text"]
                                }
                            ]
                        }, (oSlackError, oSlackResponse) => {});
                        return;
                    }

                    const aStdError = Object.values(oResults)
                                            .filter(oResult => oResult.stderr && oResult.stderr.length > 0)
                                            .map(oResult => `$ ${oResult.command}\n${oResult.stdout.trim()}\n${oResult.stderr.trim()}`);

                    oLogger.d('Githook.complete', {commit: oBody.head_commit.id, build: JSON.stringify(oResults)});

                    let sTitle = 'Build Complete';
                    if (bIsReleaseBranch) {
                        sTitle = 'Build Complete and Installed';
                    }

                    let aAttachments = [
                        {
                            fallback:    `${CONFIG.uri.domain}: I finished a Build for repo ${sRepo}, commits ${sCompare} by *${oBody.sender.login}* with message:\n> ${oBody.head_commit.message}`,
                            title:       sTitle,
                            title_link:  oBody.compare,
                            color:       'good',
                            text:        `${CONFIG.uri.domain} - ${sRepo} - ${sCompare} - ${sRelease} - ${sLogs}`,
                        }
                    ];

                    if (aStdError && aStdError.length > 0) {
                        aAttachments[0].title = sTitle + ", with stderr output";
                        aAttachments[0].color = 'warning';
                        aAttachments.push(
                            {
                                text:  "```\n" + aStdError.join('\n') + "\n```"
                            }
                        )
                    }

                    oSlack.send({
                        attachments: aAttachments
                    }, (err, response) => {});

                    oLogger.d('Githook.notified');
                    oLogger.summary();
                });
            });
        } else if (oHeaders && oHeaders['x-github-event'] === 'ping') {
            oLogger.i('Githook.request.ping', {method: sMethod, url: sUrl});

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

            oLogger.w('Githook.request.weird', {method: sMethod, url: sUrl});
            oLogger.summary();
        }
    };

    /*
    This is not currently active.  The basic premise is to watch for the /instances key, which is
    where all active instances post their most-recently installed version after a successful install.
    This means we could potentially know when all instances have the most recent version
     */
    const watchInstanceVersions = () => {
        const oWatch = consul.watch({method: consul.kv.get, options: {key: 'instances/', recurse: true}});

        oWatch.on('change', (aData, oResponse) => {
            if (!aData) {
                return;
            }

            let aUpdate = [];

            aData.forEach(oData => {
                const aKey = oData.Key.match(/instances\/([^/]+)\/software\/(.+)/);

                if (aKey) {
                    aUpdate.push({
                        instance: aKey[1],
                        app:      aKey[2],
                        release:  oData.Value
                    });
                }
            });

            if (aUpdate.length) {
                console.log('WatchInstanceVersions/.Update', aUpdate);
            }
        });

        oWatch.on('error', oError => {
            console.log('WatchInstanceVersions.Error', oError);
        });
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

                        oBuild.repository = `${sOwner}/${sRepo}`;
                        oBuild.branch     = sBranch ? sBranch : 'master';
                        oBuild.branch_ref = `refs/heads/${sBranch ? sBranch : 'master'}`;
                        oBuild.ssh        = CONFIG.github.ssh[sApp];

                        BUILDS[oBuild.repository] = oBuild
                    }
                });

                fCallback();
            },
            fCallback => {
                const sMessage = `Hello ${CONFIG.uri.domain}! I'm here and waiting for github updates. to\n * ${Object.values(CONFIG.github.sources).join("\n * ")}`;
                oSlack = new IncomingWebhook(CONFIG.slack.webhook.githook);
                oSlack.send({
                    text: sMessage
                }, (oError, oResponse) => {
                    GithookLogger.d('Githook.slack.greeted', {slack: CONFIG.slack.webhook.githook, message: sMessage});
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

            GithookLogger.n('Githook.configured');

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

        GithookLogger.summary('Githook.Init');
    };

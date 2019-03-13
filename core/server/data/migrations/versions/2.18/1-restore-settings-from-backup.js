const _ = require('lodash');
const Promise = require('bluebird');
const common = require('../../../../lib/common');
const settingsCache = require('../../../../services/settings/cache');
const config = require('../../../../config');
const moment = require('moment');
const fs = require('fs-extra');
const path = require('path');

module.exports.config = {
    transaction: true
};

const backupFileRegex = /ghost.([\d]{4}-[\d]{2}-[\d]{2}).json$/;

module.exports.up = (options) => {
    const contentPath = config.get('paths').contentPath;
    const dataPath = path.join(contentPath, 'data');

    const localOptions = _.merge({
        context: {internal: true}
    }, options);

    return fs.readdir(dataPath).then(function (files) {
        const backups = files.filter(function (filename) {
            return backupFileRegex.test(filename);
        }).sort(function (a, b) {
            const dateA = new Date(a.match(backupFileRegex)[1]);
            const dateB = new Date(b.match(backupFileRegex)[1]);

            return dateB - dateA;
        });

        if (backups.length === 0) {
            common.logging.warn('No backup files found, skipping...');
            return;
        }

        const mostRecentBackup = backups[0];

        common.logging.info(`Using backupfile ${path.join(dataPath, mostRecentBackup)}`);

        const backup = require(path.join(dataPath, mostRecentBackup));
        const settings = backup && backup.data && backup.data.settings;
        const migrations = backup && backup.data && backup.data.migrations;

        if (!settings) {
            common.logging.warn('Could not read settings from backup file, skipping...');
            return;
        }

        if (!migrations || !migrations.length) {
            common.logging.warn('Skipping migration. Not affected.');
            return;
        }

        // NOTE: If we you have a backup file which has 2.16, but not 2.17, you are affected
        // NOTE: We have corrected 2.17. If you jump form 2.16 to 2.18, you are good
        const isAffected = _.find(migrations, {version: '2.16'}) &&
            !_.find(migrations, {version: '2.17'});

        if (!isAffected) {
            common.logging.warn('Skipping migration. Not affected.');
            return;
        }

        common.logging.warn('...is affected.');

        const relevantBackupSettings = settings.filter(function (entry) {
            return ['is_private', 'force_i18n', 'amp'].includes(entry.key);
        }).reduce(function (obj, entry) {
            return Object.assign(obj, {
                [entry.key]: entry
            });
        }, {});

        return localOptions
            .transacting('settings')
            .then((response) => {
                if (!response) {
                    common.logging.warn('Cannot find settings.');
                    return;
                }

                const relevantLiveSettings = response.filter(function (entry) {
                    return ['is_private', 'force_i18n', 'amp'].includes(entry.key);
                });

                return Promise.each(relevantLiveSettings, (liveSetting) => {
                    const backupSetting = relevantBackupSettings[liveSetting.key];

                    if (liveSetting.value === 'false' && backupSetting.value === 'true') {
                        common.logging.info(`Reverting setting ${liveSetting.key}`);

                        return localOptions
                            .transacting('settings')
                            .where('key', liveSetting.key)
                            .update({
                                value: backupSetting.value
                            })
                            .then(() => {
                                // CASE: we have to update settings cache, because Ghost is able to run migrations on the same process
                                settingsCache.set(liveSetting.key, {
                                    id: liveSetting.id,
                                    key: liveSetting.key,
                                    type: liveSetting.type,
                                    created_at: moment(liveSetting.created_at).startOf('seconds').toDate(),
                                    updated_at: moment().startOf('seconds').toDate(),
                                    updated_by: liveSetting.updated_by,
                                    created_by: liveSetting.created_by,
                                    value: backupSetting.value === 'true'
                                });
                            });
                    }

                    return Promise.resolve();
                });
            });
    });
};
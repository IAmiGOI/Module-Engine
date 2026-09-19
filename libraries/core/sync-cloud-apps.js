/**
 * Ключи приложений облачных дисков. Публичные по природе: у Dropbox с PKCE секрета нет вовсе, у Google клиента типа «устройство»
 * секрет по определению не считается конфиденциальным. Пусто, пока автор расширения не зарегистрировал приложения; до тех пор
 * пользователь может вписать СВОИ ключи в карточке (раздел «use my own app») — ничего не мешает работе и без встроенных.
 */

export const BUILT_IN_CLOUD_APPS = Object.freeze({
    dropbox: Object.freeze({ clientId: '' }),
    // Клиент типа «TVs and Limited Input devices»: секрет по определению публичный (документация Google), встраивание безопасно.
    google: Object.freeze({ clientId: '415626430553-vb910257f8oh683iaqd0ddgodf6dnjtm.apps.googleusercontent.com', clientSecret: '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' }),
});

export const CLOUD_PROVIDER_LABELS = Object.freeze({ dropbox: 'Dropbox', google: 'Google Drive' });

/** Ключи для провайдера: свои у пользователя важнее встроенных. Пустой `clientId` — «ключей нет». */
export function resolveCloudApp(provider, cloud = {}, builtIn = BUILT_IN_CLOUD_APPS) {
    const own = cloud.apps?.[provider] ?? {};
    const base = builtIn[provider] ?? {};
    return { clientId: own.clientId || base.clientId || '', clientSecret: own.clientSecret || base.clientSecret || '', custom: Boolean(own.clientId) };
}

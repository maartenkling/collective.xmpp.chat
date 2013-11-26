$('#chatpanel').ready(function () {
    $(document).unbind('jarnxmpp.connected');
    $(document).bind('jarnxmpp.connected', function (ev, connection) {
        var $chatdata = $('#collective-xmpp-chat-data');
        converse.initialize({
            animate: true,
            prebind: true,
            connection: connection,
            xhr_user_search: true,
            allow_muc: false,
            auto_subscribe: false,
            auto_list_rooms: false,
            hide_muc_server: true,
            i18n: window.locales[$chatdata.attr('lang')||'nl'],
            debug: true
        });
    });
});

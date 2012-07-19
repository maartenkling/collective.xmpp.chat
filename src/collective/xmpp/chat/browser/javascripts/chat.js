var xmppchat = (function (jarnxmpp, $, console) {
    var ob = jarnxmpp;
    /* FIXME: XEP-0136 specifies 'urn:xmpp:archive' but the mod_archive_odbc 
    *  add-on for ejabberd wants the URL below. This might break for other
    *  Jabber servers.
    */
    ob.Collections = {
        'URI': 'http://www.xmpp.org/extensions/xep-0136.html#ns'
    };
    ob.Messages = jarnxmpp.Messages || {};
    ob.Presence = jarnxmpp.Presence || {};

    ob.Messages.ClientStorage = (function () {
        // TODO: Messages must be encrypted with a key and salt
        methods = {};

        methods.addMessage = function (jid, msg, direction) {
            var bare_jid = Strophe.getBareJidFromJid(jid),
                now = new Date().toISOString(),
                msgs = store.get(bare_jid) || [];
            if (msgs.length >= 30) {
                msgs.shift();
            }
            msgs.push(now+' '+direction+' '+msg);
            store.set(bare_jid, msgs);
        };

        methods.getMessages = function (jid) {
            return store.get(jid) || [];
        };
        return methods;
    })();

    ob.Messages.getMessages = function (jid, callback) {
        var bare_jid = Strophe.getBareJidFromJid(jid),
            msgs = this.ClientStorage.getMessages(bare_jid);
        callback(msgs);
    };

    ob.Collections.getLastCollection = function (jid, callback) {
        var bare_jid = Strophe.getBareJidFromJid(jid),
            iq = $iq({'type':'get'})
                    .c('list', {'xmlns': this.URI,
                                'with': bare_jid
                                })
                    .c('set', {'xmlns': 'http://jabber.org/protocol/rsm'})
                    .c('before').up()
                    .c('max')
                    .t('1');

        xmppchat.connection.sendIQ(iq, 
                    callback,
                    function () { 
                        console.log('Error while retrieving collections'); 
                    });
    };

    ob.Collections.getLastMessages = function (jid, callback) {
        var that = this;
        this.getLastCollection(jid, function (result) {
            // Retrieve the last page of a collection (max 30 elements). 
            var $collection = $(result).find('chat'),
                jid = $collection.attr('with'),
                start = $collection.attr('start'),
                iq = $iq({'type':'get'})
                        .c('retrieve', {'start': start,
                                    'xmlns': that.URI,
                                    'with': jid
                                    })
                        .c('set', {'xmlns': 'http://jabber.org/protocol/rsm'})
                        .c('max')
                        .t('30');
            xmppchat.connection.sendIQ(iq, callback);
        });
    };
    return ob;
})(jarnxmpp || {}, jQuery, console || {log: function(){}});


xmppchat.ChatBox = Backbone.Model.extend({

    hash: function (str) {
        var shaobj = new jsSHA(str);
        return shaobj.getHash("HEX");
    },

    initialize: function () {
        this.set({
            'user_id' : Strophe.getNodeFromJid(this.get('jid')),
            'chat_id' : this.hash(this.get('jid'))
        });
    }

});

xmppchat.ChatBoxView = Backbone.View.extend({
    tagName: 'div',
    className: 'chatbox',

    events: {
        'click .close-chatbox-button': 'closeChat',
        'keypress textarea.chat-textarea': 'keyPressed'
    },

    message_template: _.template(
                        '<div class="chat-message <%=extra_classes%>">' + 
                            '<span class="chat-message-<%=sender%>"><%=time%> <%=username%>:&nbsp;</span>' + 
                            '<span class="chat-message-content"><%=message%></span>' + 
                        '</div>'),

    appendMessage: function (message) {
        var time, 
            now = new Date(),
            minutes = now.getMinutes().toString(),
            list,
            $chat_content;

        message = message.replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");
        list = message.match(/\b(http:\/\/www\.\S+\.\w+|www\.\S+\.\w+|http:\/\/(?=[^w]){3}\S+[\.:]\S+)[^ ]+\b/g);
        if (list) {
            for (i = 0; i < list.length; i++) {
                message = message.replace(list[i], "<a target='_blank' href='" + escape( list[i] ) + "'>"+ list[i] + "</a>" );
            }
        }
        if (minutes.length==1) {minutes = '0'+minutes;}
        time = now.toLocaleTimeString().substring(0,5);
        $chat_content = $(this.el).find('.chat-content');
        $chat_content.append(this.message_template({
                            'sender': 'me', 
                            'time': time, 
                            'message': message, 
                            'username': 'me',
                            'extra_classes': ''
                        }));
        $chat_content.scrollTop($chat_content[0].scrollHeight);
    },

    insertStatusNotification: function (message) {
        var $chat_content = this.$el.find('.chat-content');
        $chat_content.find('div.chat-event').remove().end()
            .append($('<div class="chat-event"></div>').text(this.model.get('user_id')+' '+message));
        $chat_content.scrollTop($chat_content[0].scrollHeight);
    },

    messageReceived: function (message) {
        /* XXX: event.mtype should be 'xhtml' for XHTML-IM messages, 
            but I only seem to get 'text'. 

            XXX: Some messages might be delayed, we must get the time from the event.
        */
        var body = $(message).children('body').text(),
            jid = $(message).attr('from'),
            composing = $(message).find('composing'),
            $chat_content = $(this.el).find('.chat-content'),
            user_id = Strophe.getNodeFromJid(jid);

        if (!body) {
            if (composing.length > 0) {
                this.insertStatusNotification('is typing');
                return;
            }
        } else {
            // TODO: ClientStorage 
            xmppchat.Messages.ClientStorage.addMessage(jid, body, 'from');
            if (xmppchat.xmppstatus.getOwnStatus() === 'offline') {
                // only update the UI if the user is not offline
                return;
            }
            $chat_content.find('div.chat-event').remove();
            $chat_content.append(
                    this.message_template({
                        'sender': 'them', 
                        'time': (new Date()).toLocaleTimeString().substring(0,5),
                        'message': body.replace(/<br \/>/g, ""),
                        'username': user_id,
                        'extra_classes': ($(message).find('delay').length > 0) && 'delayed' || ''
                    }));
            $chat_content.scrollTop($chat_content[0].scrollHeight);
        }
    },

    insertClientStoredMessages: function () {
        var that = this;
        xmppchat.Messages.getMessages(this.model.get('jid'), function (msgs) {
            var $content = that.$el.find('.chat-content');
            for (var i=0; i<_.size(msgs); i++) {
                var msg = msgs[i], 
                    msg_array = msg.split(' ', 2),
                    date = msg_array[0];

                if (msg_array[1] == 'to') {
                    $content.append(
                            that.message_template({
                                'sender': 'me', 
                                'time': new Date(Date.parse(date)).toLocaleTimeString().substring(0,5),
                                'message': String(msg).replace(/(.*?\s.*?\s)/, ''),
                                'username': 'me',
                                'extra_classes': 'delayed'
                            }));
                } else {
                    $content.append(
                            that.message_template({
                                'sender': 'them', 
                                'time': new Date(Date.parse(date)).toLocaleTimeString().substring(0,5),
                                'message': String(msg).replace(/(.*?\s.*?\s)/, ''),
                                'username': that.model.get('user_id'),
                                'extra_classes': 'delayed'
                            }));
                }
            }
        });
    },

    sendMessage: function (text) {
        // TODO: Also send message to all my own connected resources, so that
        // they can display it as well....
    
        // TODO: Look in ChatPartners to see what resources we have for the recipient.
        // if we have one resource, we sent to only that resources, if we have multiple
        // we send to the bare jid.
        var bare_jid = this.model.get('jid');
        var message = $msg({to: bare_jid, type: 'chat'})
            .c('body').t(text).up()
            .c('active', {'xmlns': 'http://jabber.org/protocol/chatstates'});
        xmppchat.connection.send(message);
        xmppchat.Messages.ClientStorage.addMessage(bare_jid, text, 'to');
        this.appendMessage(text);
    },

    keyPressed: function (ev) {
        var $textarea = $(ev.target),
            message,
            notify,
            composing,
            that = this;

        if(ev.keyCode == 13) {
            message = $textarea.val();
            message = message.replace(/^\s+|\s+jQuery/g,"");
            $textarea.val('').focus();
            if (message !== '') {
                this.sendMessage(message);
            }
            $(this.el).data('composing', false);
        } else {
            composing = $(this.el).data('composing');
            if (!composing) {
                notify = $msg({'to':this.model.get('jid'), 'type': 'chat'})
                                .c('composing', {'xmlns':'http://jabber.org/protocol/chatstates'});
                xmppchat.connection.send(notify);
                $(this.el).data('composing', true);
            }
        }
    },

    addChatToCookie: function () {
        var cookie = jQuery.cookie('chats-open-'+xmppchat.username),
            jid = this.model.get('jid'),
            new_cookie,
            open_chats = [];

        if (cookie) {
            open_chats = cookie.split('|');
        }
        if (!_.has(open_chats, jid)) {
            // Update the cookie if this new chat is not yet in it.
            open_chats.push(jid);
            new_cookie = open_chats.join('|');
            jQuery.cookie('chats-open-'+xmppchat.username, new_cookie, {path: '/'});
            console.log('updated cookie = ' + new_cookie + '\n');
        }
    },

    removeChatFromCookie: function () {
        var cookie = jQuery.cookie('chats-open-'+xmppchat.username),
            open_chats = [],
            new_chats = [];

        if (cookie) {
            open_chats = cookie.split('|');
        }
        for (var i=0; i < open_chats.length; i++) {
            if (open_chats[i] != this.model.get('jid')) {
                new_chats.push(open_chats[i]);
            }
        }
        if (new_chats.length) {
            jQuery.cookie('chats-open-'+xmppchat.username, new_chats.join('|'), {path: '/'});
        }
        else {
            jQuery.cookie('chats-open-'+xmppchat.username, null, {path: '/'});
        }
    },

    closeChat: function () {
        var that = this;
        $('#'+this.model.get('chat_id')).hide('fast', function () {
            that.removeChatFromCookie(that.model.get('id'));
            // Only reorder chats if it wasn't the last chat being closed.
            var offset = parseInt($(that.el).css('right'), 10) + xmppchat.chatboxesview.chatbox_width;
            if ($("div[style*='right: "+offset+"px']").length > 0) {
                xmppchat.chatboxesview.reorderChats();
            }
        });
    },

    initialize: function (){
        $('body').append($(this.el).hide());

        xmppchat.roster.on('change', function (item, changed) {
            if (_.has(changed.changes, 'status')) {
                if (this.$el.is(':visible')) {
                    if (item.get('status') === 'offline') {
                        this.insertStatusNotification('has gone offline');
                    } else if (item.get('status') === 'away') {
                        this.insertStatusNotification('has gone away');
                    } else if (item.get('status') === 'busy') {
                        this.insertStatusNotification('is busy');
                    } else if (item.get('status') === 'online') {
                        this.$el.find('div.chat-event').remove();
                    }
                }
            }
        }, this);
    },

    template:   _.template('<div class="chat-head chat-head-chatbox">' +
                    '<div class="chat-title"> <%= user_id %> </div>' +
                    '<a href="javascript:void(0)" class="chatbox-button close-chatbox-button">X</a>' +
                    '<br clear="all"/>' +
                '</div>' +
                '<div class="chat-content"></div>' + 
                '<form class="sendXMPPMessage" action="" method="post">' +
                '<textarea ' +
                    'type="text" ' +
                    'class="chat-textarea" ' +
                    'placeholder="Personal message"/>'),

    render: function () {
        $(this.el).attr('id', this.model.get('chat_id'));
        $(this.el).html(this.template(this.model.toJSON()));
        this.insertClientStoredMessages();
        return this;
    },

    isVisible: function () {
        return $(this.el).is(':visible');
    },

    focus: function () {
        $(this.el).find('.chat-textarea').focus();
        return this;
    },

    show: function () {
        var that = this;
        $(this.el).show('fast', function () {
            that.focus();
        });
        return this;
    },

    scrolldown: function () {
        var  $content = this.$el.find('.chat-content');
        $content.scrollTop($content[0].scrollHeight);
    }
});

xmppchat.ContactsPanel = Backbone.View.extend({
    el: '#users',
    events: {
        'click div.add-xmpp-contact': 'toggleContactForm',
        'submit form.search-xmpp-contact': 'searchContacts',
        'click a.subscribe-to-user': 'subscribeToContact'
    },

    toggleContactForm: function (ev) {
        ev.preventDefault();
        this.$el.find('form.search-xmpp-contact').fadeToggle('medium').find('input.username').focus();
    },

    searchContacts: function (ev) {
        ev.preventDefault();
        $.getJSON(portal_url + "/search-users?q=" + $(ev.target).find('input.username').val(), function (data) {
            var $results_el = $('#found-users');
            $(data).each(function (idx, obj) {
                if ($results_el.children().length > 0) {  
                    $results_el.empty();
                }
                $results_el.append(
                        $('<li></li>')
                            .attr('id', 'found-users-'+obj.id)
                            .append(
                                $('<a class="subscribe-to-user" href="#" title="Click to add as a chat contact"></a>')
                                    .attr('data-recipient', obj.id+'@'+xmppchat.connection.domain)
                                    .text(obj.fullname)
                            )
                    );
            });
        });
    },

    subscribeToContact: function (ev) {
        ev.preventDefault();
        var jid = $(ev.target).attr('data-recipient');
        xmppchat.connection.roster.add(jid, '', [], function (iq) {
            // XXX: We can set the name here!!!
            xmppchat.connection.roster.subscribe(jid);
        });
        $(ev.target).parent().remove();
        $('form.search-xmpp-contact').hide();
    }

});

xmppchat.RoomsPanel = Backbone.View.extend({
    el: '#chatrooms',
    initialize: function () {
    }
});

xmppchat.SettingsPanel = Backbone.View.extend({
    el: '#settings'
});


xmppchat.ControlBox = xmppchat.ChatBox.extend({
    initialize: function () {
        this.set({
            'chat_id' : 'online-users-container'
        });
    }
});

xmppchat.ControlBoxView = xmppchat.ChatBoxView.extend({
    el: '#online-users-container',
    events: {
        'click a.close-controlbox-button': 'closeChat'
    },

    initialize: function () {
        var userspanel; 
        $('ul.tabs').tabs('div.panes > div');
        this.contactspanel = new xmppchat.ContactsPanel();
        this.roomspanel = new xmppchat.RoomsPanel();
        this.settingspanel = new xmppchat.SettingsPanel();
    },

    render: function () {
        return this;
    },

    show: function () {
        $(this.el).show();
        return this;
    }
});

xmppchat.ChatRoom = Backbone.Model.extend();

xmppchat.ChatRoomView = Backbone.Model.extend({
    tagName: 'div',
    className: 'chatroom',

    template: _.template(
            '<div class="chat-head chat-head-chatroom">' +
                '<div id="toolbar">' +
                    '<input id="leave" type="button" value="Leave Room" disabled="disabled">' +
                '</div>' +
            '</div>' +
            '<div>' +
                '<div id="chat-area">' +
                    '<div>' +
                        '<div id="room-name"></div>' +
                        '<div id="room-topic"></div>' +
                    '</div>' +
                    '<div id="chat">' +
                    '</div>' +
                    '<textarea ' +
                        'type="text" ' +
                        'class="chat-textarea" ' +
                        'placeholder="Message"/>' +
                '</div>' +
                '<div id="participants">' +
                    '<ul id="participant-list"></ul>' +
                '</div>' +
            '</div>')

});


xmppchat.ChatBoxes = Backbone.Collection.extend();

xmppchat.ChatBoxesView = Backbone.View.extend({
    
    chatbox_width: 212,
    chatbox_padding: 15,

    restoreOpenChats: function () {
        var cookie = jQuery.cookie('chats-open-'+xmppchat.username),
            open_chats = [];

        jQuery.cookie('chats-open-'+xmppchat.username, null, {path: '/'});
        if (cookie) {
            open_chats = cookie.split('|');
            if (_.indexOf(open_chats, 'online-users-container') != -1) {
                this.createChat('online-users-container');
            }
            for (var i=0; i<open_chats.length; i++) {
                if (open_chats[i] === 'online-users-container') {
                    continue;
                }
                this.createChat(open_chats[i]);
            }
        }
    },

    createChat: function (jid) {
        var chatbox;
        if (jid === 'online-users-container') {
            chatbox = new xmppchat.ControlBox({'id': jid, 'jid': jid});
            view = new xmppchat.ControlBoxView({
                model: chatbox 
            });
        } else {
            chatbox = new xmppchat.ChatBox({'id': jid, 'jid': jid});
            view = new xmppchat.ChatBoxView({
                model: chatbox 
            });
        }
        this.views[jid] = view.render();
        this.options.model.add(chatbox);
        return view;
    },

    closeChat: function (jid) {
        var view = this.views[jid];
        if (view) {
            view.closeChat();
        }
    },

    openChat: function (jid) {
        if (!this.model.get(jid)) {
            this.createChat(jid);
        } else {
            this.positionNewChat(jid);
        }
    },

    positionNewChat: function (jid) {
        var view = this.views[jid],
            that = this,
            open_chats = 0,
            offset;

        if (view.isVisible()) {
            view.focus();
        } else {
            if (jid === 'online-users-container') {
                offset = this.chatbox_padding;
                $(view.el).css({'right': (offset+'px')});
                $(view.el).show('fast', function () {
                    view.el.focus();
                    that.reorderChats();
                });
            } else {
                for (var i=0; i<this.model.models.length; i++) {
                    if ($("#"+this.model.models[i].get('chat_id')).is(':visible')) {
                        open_chats++;
                    }
                }
                offset = (open_chats)*(this.chatbox_width)+this.chatbox_padding;
                $(view.el).css({'right': (offset+'px')});
                $(view.el).show('fast', function () {
                    view.el.focus();
                    view.scrolldown();
                });
            }
            view.addChatToCookie();
        }
        return view;
    },

    reorderChats: function () {
        var index = 0,
            offset,
            chat_id,
            $chat;

        if (this.model.get('online-users-container')) {
            $chat = $("#online-users-container");
            if ($chat.is(':visible')) {
                offset = (index)*(this.chatbox_width)+this.chatbox_padding;
                $chat.animate({'right': offset +'px'});
                index = 1;
            }
        }
        for (var i=0; i<this.model.models.length; i++) {
            chat_id = this.model.models[i].get('chat_id');
            if (chat_id === 'online-users-container') {
                continue;
            }
            $chat = $("#"+chat_id);
            if ($chat.is(':visible')) {
                if (index === 0) {
                    $chat.animate({'right': '15px'});
                } 
                else {
                    offset = (index)*(this.chatbox_width)+this.chatbox_padding;
                    $chat.animate({'right': offset +'px'});
                }
                index++;
            }
        }
    },

    messageReceived: function (message) {
        var jid = $(message).attr('from'),
            bare_jid = Strophe.getBareJidFromJid(jid),
            resource = Strophe.getResourceFromJid(jid),
            view = this.views[bare_jid];

        if (!view) {
            view = this.createChat(bare_jid);
        }
        view.messageReceived(message);
        // XXX: Is this the right place for this? Perhaps an event?
        xmppchat.roster.addResource(bare_jid, resource);
    },

    initialize: function () {
        this.options.model.on("add", function (item) {
            this.positionNewChat(item.get('id'));
        }, this);

        this.views = {};
        this.restoreOpenChats();
    }
});


xmppchat.RosterItem = Backbone.Model.extend({

    initialize: function (jid, subscription, ask) {
        // FIXME: the fullname is set to user_id for now...
        var user_id = Strophe.getNodeFromJid(jid);

        this.set({
            'id': jid,
            'jid': jid,
            'ask': ask,
            'bare_jid': Strophe.getBareJidFromJid(jid),
            'user_id': user_id,
            'subscription': subscription,
            'fullname': user_id, 
            'resources': [],
            'status': 'offline'
        }, {'silent': true});
    }
});


xmppchat.RosterItemView = Backbone.View.extend({
    tagName: 'dd',

    openChat: function () {
        var jid = this.model.get('jid');
        xmppchat.chatboxesview.openChat(jid);
    },

    removeContact: function () {
        var that = this;
        $("<span></span>").dialog({
            title: 'Are you sure you want to remove this contact?',
            dialogClass: 'remove-xmpp-contact-dialog',
            resizable: false,
            width: 200,
            position: {
                my: 'center',
                at: 'center',
                of: '#online-users-container'
                },
            modal: true,
            buttons: {
                "Remove": function() {
                    $(this).dialog( "close" );
                    xmppchat.connection.roster.unauthorize(that.model.get('jid'));
                    xmppchat.roster.remove(bare_jid);
                    xmppchat.connection.roster.remove(bare_jid);
                },
                "Cancel": function() {
                    $(this).dialog( "close" );
                }
            }
        });
    },

    acceptRequest: function () {
        xmppchat.connection.roster.authorize(this.model.get('jid'));
        xmppchat.connection.roster.subscribe(this.model.get('jid'));
    },

    declineRequest: function () {
        var that = this;
        xmppchat.connection.roster.unauthorize(this.model.get('jid'));
        that.trigger('decline-request', that.model);
    },

    template: _.template(
                '<a class="open-chat" title="Click to chat with this contact" href="#"><%= fullname %></a>' +
                '<a class="remove-xmpp-contact" title="Click to remove this contact" href="#"></a>'),

    request_template: _.template('<%= fullname %>' +
                '<button type="button" class="accept-xmpp-request">' +
                'Accept</button>' +
                '<button type="button" class="decline-xmpp-request">' +
                'Decline</button>' +
                ''),

    render: function () {
        var item = this.model,
            ask = item.get('ask'),
            that = this,
            subscription = item.get('subscription');

        $(this.el).addClass(item.get('status')).attr('id', 'online-users-'+item.get('user_id'));
        
        if (ask === 'subscribe') {
            this.$el.addClass('pending-xmpp-contact');
            $(this.el).html(this.template(item.toJSON()));
        } else if (ask === 'request') {
            this.$el.addClass('requesting-xmpp-contact');
            $(this.el).html(this.request_template(item.toJSON()));
            this.$el.find('button.accept-xmpp-request').on('click', function (ev) {
                ev.preventDefault();
                that.acceptRequest();
            });
            this.$el.find('button.decline-xmpp-request').on('click', function (ev) {
                ev.preventDefault();
                that.declineRequest();
            });
        } else if (subscription === 'both') {
            this.$el.addClass('current-xmpp-contact');
            this.$el.html(this.template(item.toJSON()));
            this.$el.find('a.open-chat').on('click', function (ev) {
                ev.preventDefault();
                that.openChat();
            });
            this.$el.find('a.remove-xmpp-contact').on('click', function (ev) {
                ev.preventDefault();
                that.removeContact();
            });
        }
        return this;
    },

    initialize: function () {
        this.options.model.on('change', function (item, changed) {
            if (_.has(changed.changes, 'status')) {
                $(this.el).attr('class', item.changed.status);
            }
        }, this);
    }
});


xmppchat.Roster = (function (_, $, console) {
    var ob = {},
        Collection = Backbone.Collection.extend({
            model: xmppchat.RosterItem,
            stropheRoster: xmppchat.connection.roster,

            initialize: function () {
                this._connection = xmppchat.connection;
            },

            comparator : function (rosteritem) {
                var status = rosteritem.get('status'),
                    rank = 4;
                switch(status) {
                    case 'offline': 
                        rank = 4;
                        break;
                    case 'unavailable':
                        rank = 3;
                        break;
                    case 'away':
                        rank = 2;
                        break;
                    case 'busy':
                        rank = 1;
                        break;
                    case 'online':
                        rank = 0;
                        break;
                }
                return rank;
            },

            isSelf: function (jid) {
                return (Strophe.getBareJidFromJid(jid) === Strophe.getBareJidFromJid(xmppchat.connection.jid));
            },

            getRoster: function () {
                return xmppchat.connection.roster.get();
            },

            getItem: function (id) {
                return Backbone.Collection.prototype.get.call(this, id);
            },

            addRosterItem: function (jid, subscription, ask) {
                var model = new xmppchat.RosterItem(jid, subscription, ask);
                this.add(model);
            },
                
            addResource: function (bare_jid, resource) {
                var item = this.getItem(bare_jid),
                    resources;
                if (item) {
                    resources = item.get('resources');
                    if (_.indexOf(resources, resource) == -1) {
                        resources.push(resource);
                        item.set({'resources': resources});
                    }
                } else  {
                    item.set({'resources': [resource]});
                }
            },

            removeResource: function (bare_jid, resource) {
                var item = this.getItem(bare_jid),
                    resources,
                    idx;
                if (item) {
                    resources = item.get('resources');
                    idx = _.indexOf(resources, resource);
                    if (idx !== -1) {
                        resources.splice(idx, 1);
                        item.set({'resources': resources});
                        return resources.length;
                    }
                }
                return 0;
            },

            clearResources: function (bare_jid) {
                var item = this.getItem(bare_jid);
                if (item) {
                    item.set({'resources': []});
                }
            },

            getTotalResources: function (bare_jid) {
                var item = this.getItem(bare_jid);
                if (item) {
                    return _.size(item.get('resources'));
                }
            },

            getNumOnlineContacts: function () {
                var count = 0;
                for (var i=0; i<this.models.length; i++) {
                    if (_.indexOf(['offline', 'unavailable'], this.models[i].get('status')) === -1) {
                        count++;
                    }
                }
                return count;
            }

        });

    var collection = new Collection();
    _.extend(ob, collection);
    _.extend(ob, Backbone.Events);

    ob.rosterHandler = function (items) {
        var model, item;
        for (var i=0; i<items.length; i++) {
            item = items[i];
            model = ob.getItem(item.jid);
            if (!model) {
                ob.addRosterItem(item.jid, item.subscription, item.ask);
            } else {
                model.set({'subscription': item.subscription, 'ask': item.ask});
            }
        }
    };

    ob.presenceHandler = function (presence) {
        var jid = $(presence).attr('from'),
            bare_jid = Strophe.getBareJidFromJid(jid),
            resource = Strophe.getResourceFromJid(jid),
            ptype = $(presence).attr('type'),
            item,
            status = '';

        if (ob.isSelf(bare_jid)) { 
            return true; 
        }
        if (ptype === 'subscribe') {
            if (ob.getItem(bare_jid)) { 
                xmppchat.connection.roster.authorize(bare_jid);
            } else {
                ob.addRosterItem(bare_jid, 'none', 'request');
            }
        } else if (ptype === 'subscribed') {
            return true;
        } else if (ptype === 'unsubscribe') {
            return true;
        } else if (ptype === 'unsubscribed') {
            /* Upon receiving the presence stanza of type "unsubscribed", 
             * the user SHOULD acknowledge receipt of that subscription state 
             * notification by sending a presence stanza of type "unsubscribe" 
             * this step lets the user's server know that it MUST no longer 
             * send notification of the subscription state change to the user.
             */
            xmppchat.xmppstatus.sendPresence('unsubscribe');
            if (xmppchat.connection.roster.findItem(bare_jid)) {
                xmppchat.roster.remove(bare_jid);
                xmppchat.connection.roster.remove(bare_jid);
            }
            return true;
        } else if (ptype === 'error') {
            return true;

        } else if (ptype !== 'error') { // Presence has changed
            if (_.indexOf(['unavailable', 'offline', 'busy', 'away'], ptype) != -1) {
                status = ptype;
            } else {
                status = ($(presence).find('show').text() === '') ? 'online' : 'away';
            }
            if ((status !== 'offline')&&(status !== 'unavailable')) {
                ob.addResource(bare_jid, resource);
                model = ob.getItem(bare_jid);
                model.set({'status': status});
            } else {
                if (ob.removeResource(bare_jid, resource) === 0) {
                    model = ob.getItem(bare_jid);
                    model.set({'status': status});
                }
            }
        }
        return true;
    };
    return ob;
});


xmppchat.RosterView= (function (roster, _, $, console) {
    var View = Backbone.View.extend({
        el: $('#xmppchat-roster'),
        model: roster,
        rosteritemviews: {},

        initialize: function () {
            this.model.on("add", function (item) {
                var view = new xmppchat.RosterItemView({model: item});
                this.rosteritemviews[item.id] = view;
                if (item.get('ask') === 'request') {
                    view.on('decline-request', function (item) {
                        this.model.remove(item.id);
                    }, this);
                }
                this.render();
            }, this);

            this.model.on('change', function (item) {
                this.render();
            }, this);

            this.model.on("remove", function (item) {
                delete this.rosteritemviews[item.id];
                this.render();
            }, this);
        },

        template: _.template('<dt id="xmpp-contact-requests">Contact requests</dt>' +
                            '<dt id="xmpp-contacts">My contacts</dt>' +
                            '<dt id="pending-xmpp-contacts">Pending contacts</dt>'),

        render: function () {
            this.$el.empty().html(this.template());
            var models = this.model.sort().models,
                children = $(this.el).children(),
                my_contacts = this.$el.find('#xmpp-contacts').hide(),
                contact_requests = this.$el.find('#xmpp-contact-requests').hide(),
                pending_contacts = this.$el.find('#pending-xmpp-contacts').hide();

            for (var i=0; i<models.length; i++) {
                var model = models[i],
                    user_id = Strophe.getNodeFromJid(model.id),
                    view = this.rosteritemviews[model.id],
                    ask = model.get('ask'),
                    subscription = model.get('subscription');

                if (ask === 'subscribe') {
                    pending_contacts.after(view.render().el);
                } else if (ask === 'request') {
                    contact_requests.after(view.render().el);
                } else if (subscription === 'both') {
                    my_contacts.after(view.render().el);
                } 
            }
            // Hide the headings if there are no contacts under them
            _.each([my_contacts, contact_requests, pending_contacts], function (h) {
                if (h.nextUntil('dt').length > 0) {
                    h.show();
                }
            });
            $('#online-count').text(this.model.getNumOnlineContacts());
        }
    });
    var view = new View();
    return view;
});

xmppchat.XMPPStatus = Backbone.Model.extend({

    sendPresence: function (type) {
        if (type === undefined) {
            type = this.getOwnStatus() || 'online';
        }
        xmppchat.connection.send($pres({'type':type}));
    },

    getOwnStatus: function () {
        return store.get(xmppchat.connection.bare_jid+'-xmpp-status');
    },

    setOwnStatus: function (value) {
        this.sendPresence(value);
        store.set(xmppchat.connection.bare_jid+'-xmpp-status', value);
    }
});

xmppchat.XMPPStatusView = Backbone.View.extend({
    el: "span#xmpp-status-holder",

    events: {
        "click #fancy-xmpp-status-select": "toggleOptions",
        "click .dropdown dd ul li a": "setOwnStatus"
    },

    toggleOptions: function (ev) {
        ev.preventDefault();
        $(ev.target).parent().siblings('dd').find('ul').toggle('fast');
    },

    setOwnStatus: function (ev) {
        ev.preventDefault();
        var $el = $(ev.target).find('span'),
            value = $el.text();
        $(this.el).find(".dropdown dt a").html('I am ' + value).attr('class', value);
        $(this.el).find(".dropdown dd ul").hide();
        $(this.el).find("#source").val($($el).find("span.value").html());
        this.model.setOwnStatus(value);
    },

    choose_template: _.template('<dl id="target" class="dropdown">' +
                    '<dt id="fancy-xmpp-status-select">'+
                    '<a href="#" title="Click to change your chat status" class="<%= chat_status %>">' +
                    'I am <%= chat_status %> <span class="value"><%= chat_status %></span>' +
                    '</a></dt>' +
                    '<dd><ul></ul></dd>'),

    option_template: _.template(
                            '<li>' +
                                '<a href="#" class="<%= value %>">' +
                                    '<%= text %>' +
                                    '<span class="value"><%= value %></span>' +
                                '</a>' +
                            '</li>'),

    initialize: function () {
        var $select = $(this.el).find('select#select-xmpp-status'),
            chat_status = this.model.getOwnStatus() || 'offline',
            options = $('option', $select),
            that = this;

        $(this.el).html(this.choose_template({'chat_status': chat_status}));

        // iterate through all the <option> elements and create UL
        options.each(function(){
            $(that.el).find("#target dd ul").append(that.option_template({
                                                            'value': $(this).val(), 
                                                            'text': $(this).text()
                                                        })).hide();
        });
        $select.remove();
    }
});

// Event handlers
// --------------
$(document).ready(function () {
    var chatdata = jQuery('span#babble-client-chatdata'),
        $toggle = $('a#toggle-online-users');

    $toggle.unbind('click');

    xmppchat.username = chatdata.attr('username');
    xmppchat.base_url = chatdata.attr('base_url');

    $(document).unbind('jarnxmpp.connected');
    $(document).bind('jarnxmpp.connected', function () {

        xmppchat.connection.xmlInput = function (body) {
            console.log(body);
        };

        xmppchat.connection.xmlOutput = function (body) {
            console.log(body);
        };

        xmppchat.connection.bare_jid = Strophe.getBareJidFromJid(xmppchat.connection.jid);

        xmppchat.roster = xmppchat.Roster(_, $, console);
        xmppchat.rosterview = Backbone.View.extend(xmppchat.RosterView(xmppchat.roster, _, $, console));

        xmppchat.connection.addHandler(xmppchat.roster.presenceHandler, null, 'presence', null);
        
        xmppchat.connection.roster.registerCallback(xmppchat.roster.rosterHandler);
        xmppchat.roster.getRoster();

        xmppchat.chatboxes = new xmppchat.ChatBoxes();
        
        xmppchat.chatboxesview = new xmppchat.ChatBoxesView({
            'model': xmppchat.chatboxes
        });

        xmppchat.connection.addHandler(
                function (message) { 
                    xmppchat.chatboxesview.messageReceived(message);
                    return true;
                }, 
                null, 'message', 'chat');

        // XMPP Status 
        xmppchat.xmppstatus = new xmppchat.XMPPStatus();
        xmppchat.xmppstatusview = new xmppchat.XMPPStatusView({
            'model': xmppchat.xmppstatus
        });

        xmppchat.xmppstatus.sendPresence();

        // Controlbox toggler
        $toggle.bind('click', function (e) {
            e.preventDefault();
            if ($("div#online-users-container").is(':visible')) {
                xmppchat.chatboxesview.closeChat('online-users-container');
            } else {
                xmppchat.chatboxesview.openChat('online-users-container');
            }
        });
    });
});

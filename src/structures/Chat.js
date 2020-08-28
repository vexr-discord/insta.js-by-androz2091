const Collection = require('@discordjs/collection')
const Message = require('./Message')
const User = require('./User')
const Attachment = require('./Attachment')

/**
 * Represents a chat between one or more users.
 */
class Chat {
    /**
     * @param {InstaClient} client The instantiating client
     * @param {string} threadID The ID of the thread
     * @param {object} data The data for the chat
     */
    constructor (client, threadID, data) {
        /**
         * @type {InstaClient}
         * The client that instantiated this
         */
        this.client = client
        /**
         * @type {string}
         * The ID of the chat
         */
        this.id = threadID
        /**
         * @type {Collection<string, Message>}
         * The messages in the chat.
         */
        this.messages = new Collection()
        /**
         * @type {Collection<string, User>}
         * The users in the chat.
         */
        this.users = new Collection()
        /**
         * @type {Collection<string, User>}
         * The users that left the chat.
         */
        this.leftUsers = new Collection()
        /**
         * @type {boolean}
         * Whether the client is typing in the chat.
         */
        this.typing = false

        this._disableTypingOnSend = null
        this._stopTypingTimeout = null
        this._keepTypingAliveInterval = null
        this._sentMessagesPromises = new Collection()

        this._patch(data)
    }

    get threadEntity () {
        return this.client.ig.entity.directThread(this.id)
    }

    _patch (data) {
        data.users.forEach((user) => {
            const exisiting = this.client.cache.users.get(user.pk)
            if (exisiting) {
                this.users.set(user.pk, exisiting)
                this.users.get(user.pk)._patch(user)
            } else {
                this.users.set(user.pk, new User(this.client, user))
                this.client.cache.users.set(user.pk, this.users.get(user.pk))
            }
        })
        data.left_users.forEach((user) => {
            const exisiting = this.client.cache.users.get(user.pk)
            if (exisiting) {
                this.leftUsers.set(user.pk, exisiting)
                this.leftUsers.get(user.pk)._patch(user)
            } else {
                this.leftUsers.set(user.pk, new User(this.client, user))
                this.client.cache.users.set(user.pk, this.leftUsers.get(user.pk))
            }
        })
        data.items.forEach((item) => {
            this.messages.set(item.item_id, new Message(this.client, this.id, item))
        })
        /**
         * @type {string[]}
         * The IDs of the administrators of the chat.
         */
        this.adminUserIDs = data.admin_user_ids
        /**
         * @type {number}
         * The last time the chat was active.
         */
        this.lastActivityAt = data.last_activity_at
        /**
         * @type {boolean}
         * Whether the account has muted the chat.
         */
        this.muted = data.muted
        /**
         * @type {boolean}
         * Whether the account has pinned the chat.
         */
        this.isPin = data.is_pin
        /**
         * @type {boolean}
         * Whether this chat has a specific name (otherwise it's the default name).
         */
        this.named = data.named
        /**
         * @type {boolean}
         * Whether the chat is waiting for the account approval.
         */
        this.pending = data.pending
        /**
         * @type {boolean}
         * Whether the chat is a group.
         */
        this.isGroup = data.is_group
        /**
         * @type {boolean}
         * The type of the chat.
         */
        this.type = data.thread_type
    }

    /**
     * Approve the chat if it's pending.
     * @returns {Promise<void>}
     */
    async approve () {
        this.pending = false
        await this.client.ig.directThread.approve(this.id)
        if (!this.client.cache.chats.has(this.id)) this.client.cache.chats.set(this.id, this)
        this.client.cache.pendingChats.delete(this.id)
        this.client.emit('messageCreate', this.messages.first())
    }

    /**
     * Mark a message of the chat as seen
     * @param {string} messageID The ID of the message to mark as seen
     * @returns {Promise<void>}
     */
    async markMessageSeen (messageID) {
        await this.threadEntity.markItemSeen(messageID)
    }

    /**
     * Delete a message of the chat
     * @param {string} messageID The ID of the message to delete
     * @returns {Promise<void>}
     */
    async deleteMessage (messageID) {
        await this.threadEntity.deleteItem(messageID)
    }

    async _keepTypingAlive () {
        if (this.typing) {
            await this.client.ig.realtime.direct.indicateActivity({
                threadId: this.id,
                isActive: true
            })
        } else if (this._keepTypingAliveInterval) clearInterval(this._keepTypingAliveInterval)
    }

    /**
     * Start typing in the chat
     * @param {number} [options] Options
     * @param {number} [options.time=10000] For how long the client should type
     * @param {boolean} [options.disableOnSend=true] Whether the bot should stop typing when it sends a new message
     * @returns {Promise<void>}
     */
    async startTyping ({ duration, disableOnSend } = {}) {
        this.typing = true
        await this.client.ig.realtime.direct.indicateActivity({
            threadId: this.id,
            isActive: true
        })
        this._disableTypingOnSend = disableOnSend !== undefined ? disableOnSend : true
        this._stopTypingTimeout = setTimeout(() => this.stopTyping(), (duration || 10000))
        this._keepTypingAliveInterval = setInterval(() => this._keepTypingAlive(), 9000)
    }

    /**
     * Stop typing in the chat
     * @returns {Promise<void>}
     */
    async stopTyping () {
        if (this._keepTypingAliveInterval) clearTimeout(this._keepTypingAliveInterval)
        this.typing = false
        await this.client.ig.realtime.direct.indicateActivity({
            threadId: this.id,
            isActive: false
        })
    }

    /**
     * Send a message in the chat
     * @param {string} content The content of the message to send
     * @returns {Promise<Message>}
     *
     * @example
     * chat.sendMessage('hey!');
     */
    sendMessage (content, options) {
        return new Promise((resolve) => {
            this.threadEntity.broadcastText(content).then(({ item_id: itemID }) => {
                if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive()
                this._sentMessagesPromises.set(itemID, resolve)
                if (this.messages.has(itemID)) {
                    this._sentMessagesPromises.delete(itemID)
                    resolve(this.messages.get(itemID))
                }
            })
        })
    }

    /**
     * Send a voice message in the chat
     * @param {Buffer} buffer The mp4 buffer to send
     * @returns {Promise<Message>}
     *
     * @example
     * const ytdl = require('ytdl-core');
     *
     * const stream = ytdl('http://www.youtube.com/watch?v=A02s8omM_hI', { filter: format => format.container === 'mp4' });
     * const array = [];
     * stream
     *   .on('data', chunk => {
     *     array.push(chunk);
     *   })
     *   .on('end', () => {
     *     message.chat.sendVoice(Buffer.concat(array));
     *   });
     */
    sendVoice (buffer) {
        return new Promise((resolve) => {
            this.threadEntity.broadcastVoice({ file: buffer }).then(({ item_id: itemID }) => {
                if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive()
                this._sentMessagesPromises.set(itemID, resolve)
                if (this.messages.has(itemID)) {
                    this._sentMessagesPromises.delete(itemID)
                    resolve(this.messages.get(itemID))
                }
            })
        })
    }

    /**
     * Send a photo in the chat
     * @param {string|Buffer|Attachment} attachment The photo to send
     * @returns {Promise<Message>}
     *
     * @example
     * chat.sendPhoto('https://via.placeholder.com/150');
     * chat.sendPhoto('./cat.png');
     */
    sendPhoto (attachment) {
        return new Promise((resolve) => {
            if (!(attachment instanceof Attachment)) {
                attachment = new Attachment(attachment)
            }
            attachment._verify().then(() => {
                this.threadEntity.broadcastPhoto({ file: attachment.file }).then(({ item_id: itemID }) => {
                    if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive()
                    this._sentMessagesPromises.set(itemID, resolve)
                    if (this.messages.has(itemID)) {
                        this._sentMessagesPromises.delete(itemID)
                        resolve(this.messages.get(itemID))
                    }
                })
            })
        })
    }
}

module.exports = Chat
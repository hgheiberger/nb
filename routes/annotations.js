const express = require('express');
const User = require('../models').User;
const Class = require('../models').Class;
const Annotation = require('../models').Annotation;
const Thread = require('../models').Thread;
const Followers = require('../models').Followers;
const Source = require('../models').Source;
const Location = require('../models').Location;
const HtmlLocation = require('../models').HtmlLocation;
const AnnotationMedia = require('../models').AnnotationMedia
const Tag = require('../models').Tag;
const router = express.Router();
const { Op } = require("sequelize");
const utils = require('../models/utils')(require('../models'));
let socketapi = require("../socketapi")
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { url } = require('inspector');
const upload = multer({ dest: 'public/media/' });
const EmailUtil = require('../utils/emailUtil')
const EmailTemplate = require('../utils/emailTemplate')
 

/**
* Get my classes for a given source
* @name GET/api/annotations/myClasses
*/
router.get('/myClasses', async (req, res) => {
    let allSourcesByFilepath = await Source.findAll({ where: { filepath: req.query.url }, include: [{association: 'Files'}] })

    try {
        allSourcesByFilepath = allSourcesByFilepath.filter(s => !s.Files[0].dataValues.deleted)
    } catch (error) {}

    const user = await User.findByPk(req.user.id)
    const sections = await user.getMemberSections({ raw: true })
    const myClassesAsStudent = await Promise.all(sections.map((section) => Class.findByPk(section.class_id)))
    const myClassesIDsAsStudent = myClassesAsStudent.map(classObj => classObj["id"])
    const uniqueMyClassesAsStudent = myClassesAsStudent.filter((value, index) => {
        return myClassesIDsAsStudent.indexOf(value["id"]) === index
    });
    const myClassesAsInstructor = await user.getInstructorClasses()
    const myClassesAsTA = await user.getTAClasses()
    const myClasses = [...uniqueMyClassesAsStudent, ...myClassesAsInstructor, ...myClassesAsTA]
    const myClassesBySource = myClasses.filter(myClass => allSourcesByFilepath.find(source => source.class_id == myClass.id))
    res.status(200).send(myClassesBySource)
});

router.get('/myCurrentSection', (req, res) => {
    User.findByPk(req.user.id).then((user) => {
        user.getMemberSections({ raw: true }).then((sections) => {
            for (const section of sections) {
                if (section.class_id === req.query.class && !section.is_global) {
                    res.status(200).send(section.id)
                    return;
                }
            }
            res.status(200).send("")
        })
    })

})

/**
* Get all users for a given source
* @name GET/api/annotations/allUsers
*/
router.get('/allUsers', (req, res) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] }, include: [{
            association: 'Class',
            include: [
                { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id', 'username', 'first_name', 'last_name'] }] },
                { association: 'Instructors', attributes: ['id', 'username', 'first_name', 'last_name'] },
                { association: 'ClassTAs', attributes: ['id', 'username', 'first_name', 'last_name'] }]
        }]
    })
        .then((source) => {
            const students = source.Class.GlobalSection.MemberStudents
                .map((user) => simplifyUser(user, 'student'))
                .reduce((obj, user) => { obj[user.id] = user; return obj; }, {});
            const instructors = source.Class.Instructors
                .map((user) => simplifyUser(user, 'instructor'))
                .reduce((obj, user) => { obj[user.id] = user; return obj; }, {});
            const tas = source.Class.ClassTAs
                .map((user) => simplifyUser(user, 'ta'))
                .reduce((obj, user) => { obj[user.id] = user; return obj; }, {});
            res.status(200).json(Object.assign(students, instructors, tas));
        }
        );
});

/**
* Get all users for a given source
* @name GET/api/annotations/allTagTypes
*/
router.get('/allTagTypes', (req, res) => {
    Source.findOne({
        where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] }, include: [{
            association: 'Class',
            include: [{ association: 'TagTypes' }]
        }]
    })
        .then((source) => {
            const hashtags = source.Class.TagTypes
                .map((tag_type) => tag_type.get({ plain: true }))
                .reduce((obj, tag) => { obj[tag.id] = tag; return obj; }, {});
            res.status(200).json(hashtags);
        }
        );
});

/**
* Get all top-level annotation (+ replies) for a given source
* @name GET/api/annotations/annotation
* @param url: source url
* @param class: source class id
* @return [{
* id: id of annotation
* content: text content of annotation,
* range: json for location range,
* author: id of author,
* tags: list of ids of tag types,
* userTags: list of ids of users tagged,
* visibility: string enum,
* anonymity: string enum,
* replyRequest: boolean,
* star: boolean
* }]
*/
router.get('/annotation', (req, res) => {
    Followers.findAll({ where: { user_id: req.user.id}}).then((follows) => {
        Source.findOne({
            where: { [Op.and]: [{ filepath: req.query.url }, { class_id: req.query.class }] },
            include: [{
                association: 'Class',
                include: [
                    { association: 'Instructors', attributes: ['id'] },
                    { association: 'ClassTAs', attributes: ['id'] },
                    {
                        association: 'GlobalSection', include: [{
                            association: 'MemberStudents', attributes: ['id']
                        }]
                    },
                    {
                        association: 'Sections', separate: true, include: [{ // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
                            association: 'MemberStudents', attributes: ['id']
                        }]
                    }
                ]
            }]
        }).then(source => {
            let instructors = new Set(source.Class.Instructors.map(user => user.id)) // convert to set so faster to check if a user is in this set
            let tas = new Set(source.Class.ClassTAs.map(user => user.id)) // convert to set so faster to check if a user is in this set
            let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id)) // convert to set so faster to check if a user is in this set
            let isUserInstructor = instructors.has(req.user.id);
            let isUserTA = tas.has(req.user.id);
            let isUserStudent = globalSectionStudents.has(req.user.id);

            if (!isUserInstructor && !isUserStudent && !isUserTA) {
                res.status(200).json([]);
                return;
            }

            let usersICanSee = new Set([]) // convert to set so faster to check if a user is in this set
            let isSingleSectionClass = source.Class.Sections.length === 1

            for (const section of source.Class.Sections) {
                let memberIds = section.MemberStudents.map(user => user.id)
                if ((isUserInstructor && section.is_global) || (isUserTA && section.is_global) || (isSingleSectionClass)) {
                    usersICanSee = new Set(memberIds)
                    break;
                } else {
                    if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                        usersICanSee = new Set(memberIds)
                        break
                    }
                }
            }
            source.getLocations({
                include:
                    [
                        { association: 'HtmlLocation' },
                        {
                            association: 'Thread',
                            required: true,
                            include: [
                                {
                                    association: 'HeadAnnotation', attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                                    include: [
                                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'TaggedUsers', attributes: ['id'] },
                                        { association: 'Tags', attributes: ['tag_type_id'] },
                                        { association: 'Bookmarkers', attributes: ['id'] },
                                        { association: 'Spotlight', attributes: ['id', 'type'] },
                                        { association: 'Media', attributes: ['filepath', 'type'] },
                                    ]
                                },
                                {
                                    association: 'AllAnnotations', separate: true, attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                                    include: [
                                        { association: 'Parent', attributes: ['id'] },
                                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                        { association: 'TaggedUsers', attributes: ['id'] },
                                        { association: 'Tags', attributes: ['tag_type_id'] },
                                        { association: 'Bookmarkers', attributes: ['id'] },
                                        { association: 'Media', attributes: ['filepath', 'type'] },
                                    ]
                                },
                                { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                                { association: 'RepliedUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                            ]
                        }
                    ]
            }).then(locations => {
                let annotations = {}
                let headAnnotations = []

                // TODO: is this the correct way to filter replies?
                let goodLocations = locations.filter((location) => {
                    try {
                        let head = location.Thread.HeadAnnotation;

                        if (head.visibility === 'MYSELF' && head.Author.id !== req.user.id) {
                            return false;
                        }
                        if (head.visibility === 'INSTRUCTORS' && !isUserInstructor && head.Author.id !== req.user.id) {
                            return false;
                        } if (req.query.sectioned === 'true' && isUserStudent && head.Author.id !== req.user.id && !usersICanSee.has(head.Author.id) && !instructors.has(head.Author.id) && !tas.has(head.Author.id)) {
                            return false;
                        }
                        return true;
                    } catch (e) {
                        // console.log(location);
                        console.log('\n\n\nGET/api/annotations/annotation')
                        console.log(e)
                        console.log(location);
                        console.log(location.Thread);
                        console.log(location.Thread.HeadAnnotation);
                        return false;
                    }
                })

                goodLocations.forEach((location) => {
                    // store all head annotaitons
                    headAnnotations.push(utils.createAnnotation(location, location.Thread.HeadAnnotation, instructors, tas, req.user.id, follows))

                    // store all associated annotations in {parent_id : annotation} annotations object
                    location.Thread.AllAnnotations.forEach((annotation) => {
                        if (annotation.Parent) {
                            if (!(annotation.Parent.id in annotations)) {
                                annotations[annotation.Parent.id] = []
                            }
                            if (
                                (annotation.visibility === 'MYSELF' && annotation.Author.id === req.user.id)
                                || (annotation.visibility === 'INSTRUCTORS' && (isUserInstructor || annotation.Author.id === req.user.id))
                                || (annotation.visibility === 'EVERYONE')
                            ) {
                                annotations[annotation.Parent.id].push(utils.createAnnotation(location, annotation, instructors, tas, req.user.id, follows))
                            }
            
                        }
                    })
                });

                res.status(200).json({ 'headAnnotations': headAnnotations, 'annotationsData': annotations });

            })
        });
    });
});

/**
* Make new thread for a given annotation (and tell users with visbility permissions to query for this specific thread w/ socketio)
* @name POST/api/annotations/annotation
* @param url: source url
* @param class: source class id
* @param content: text content of annotation
* @param range: json for location range
* @param drawAnnotationRect: HTML rect element for the draw annotation
* @param drawAnnotationSvg: SVG element in which to insert the rect
* @param videoAnnotationStartTime: start time of the video annotation
* @param videoAnnotationEndTime: end time of the video annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
* @param bookmark: boolean
*/
router.post('/annotation', async (req, res) => {
    const source = await Source.findOne({
        where: { [Op.and]: [{ filepath: req.body.url }, { class_id: req.body.class }] },
        include: [{
            association: 'Class',
            include: [{ association: 'Instructors', attributes: ['id'] }, { association: 'ClassTAs', attributes: ['id'] },
            { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id'] }] },
            // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
            { association: 'Sections', separate: true, include: [{ association: 'MemberStudents', attributes: ['id'] }] }
            ]
        }]
    })

    let instructors = new Set(source.Class.Instructors.map(user => user.id))
    let tas = new Set(source.Class.ClassTAs.map(user => user.id))
    let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id))
    let isUserInstructor = instructors.has(req.user.id);
    let isUserTA = tas.has(req.user.id);
    let isUserStudent = globalSectionStudents.has(req.user.id);

    if (!isUserInstructor && !isUserStudent && !isUserTA) {
        res.status(200).json([]);
        return;
    }

    let usersICanSee = []
    let isSingleSectionClass = source.Class.Sections.length === 1

    for (const section of source.Class.Sections) {
        let memberIds = section.MemberStudents.map(user => user.id)

        if ((isUserInstructor && section.is_global) || (isUserTA && section.is_global) || (isSingleSectionClass)) {
            usersICanSee = memberIds
            break;
        } else {
            if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                usersICanSee = memberIds
                break
            }
        }
    }

    let annotation
    let threadId
    const location = await Location.create({ source_id: source.id })

    let htmlLoc; 
    if (req.body.drawAnnotationRect) {
        const rect = req.body.drawAnnotationRect
        const imageSvg = req.body.drawAnnotationSvg 
        htmlLoc = { start_node: imageSvg, end_node: imageSvg, start_offset: rect.x_offset, end_offset: rect.y_offset, width: rect.width, height: rect.height, location_id: location.id}
    } else {
        const range = req.body.range
        htmlLoc = { start_node: range.start, end_node: range.end, start_offset: range.startOffset, end_offset: range.endOffset, location_id: location.id }
    }

    if (req.body.videoAnnotationStartTime) {
        htmlLoc.start_time = req.body.videoAnnotationStartTime
        htmlLoc.end_time = req.body.videoAnnotationEndTime
    }

    await Promise.all([
        HtmlLocation.create(htmlLoc),
        Thread.create({ location_id: location.id, HeadAnnotation: { content: req.body.content, visibility: req.body.visibility, anonymity: req.body.anonymity, endorsed: req.body.endorsed, author_id: req.user.id } },
            { include: [{ association: 'HeadAnnotation' }] })
            .then(thread => {
                threadId = thread.id
                annotation = thread.HeadAnnotation;
                req.body.tags.forEach((tag) => Tag.create({ annotation_id: annotation.id, tag_type_id: tag }));
                req.body.userTags.forEach((user_id) => User.findByPk(user_id).then(user => annotation.addTaggedUser(user)));

                User.findByPk(req.user.id).then(user => {
                    if (req.body.replyRequest) annotation.addReplyRequester(user);
                    if (req.body.star) annotation.addStarrer(user);
                    if (req.body.bookmark) annotation.addBookmarker(user);
                    thread.setSeenUsers([user]);
                    thread.setRepliedUsers([user]);
                });

                annotation.setThread(thread).then(() => {
                    res.status(200).json(annotation)
                });
            })
    ])

    if (threadId) {
        const io = socketapi.io
        const urlHash = crypto.createHash('md5').update(req.body.url).digest('hex');
        const globalRoomId = `${urlHash}:${req.body.class}`
        const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))
        const t = await fetchSpecificThread(req.body.class, req.body.url, threadId)
    
        if (annotation.visibility === 'INSTRUCTORS') {
            // Since instructors are only part of the global section, only emit to the global room
            io.to(globalRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors], taggedUsers: [...req.body.userTags] })
        } else if (annotation.visibility === 'EVERYONE') {
            io.to(globalRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors, ...tas, ...usersICanSee], taggedUsers: [...req.body.userTags] })
            classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors, ...tas, ...usersICanSee], taggedUsers: [...req.body.userTags] }))
        }
    }

});

/**
* Make new media thread for a given annotation (and tell users with visbility permissions to query for this specific thread w/ socketio)
* @name POST/api/annotations/media/annotation
* @param url: source url
* @param class: source class id
* @param content: text content of annotation
* @param range: json for location range
* @param drawAnnotationRect: HTML rect element for the draw annotation
* @param drawAnnotationSvg: SVG element in which to insert the rect
* @param videoAnnotationStartTime: start time of the video annotation
* @param videoAnnotationEndTime: end time of the video annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
* @param bookmark: boolean
*/
router.post('/media/annotation', upload.single("file"), async (req, res) => {
    try {
        const filepath = `/media/${req.file.filename}`
        const body = JSON.parse(req.body.annotation)

        const source = await Source.findOne({
            where: { [Op.and]: [{ filepath: body.url }, { class_id: body.class }] },
            include: [{
                association: 'Class',
                include: [{ association: 'Instructors', attributes: ['id'] }, { association: 'ClassTAs', attributes: ['id'] },
                { association: 'GlobalSection', include: [{ association: 'MemberStudents', attributes: ['id'] }] },
                // with the hasMany Sections association, add a "separate: true" to make this join happen separately so that there are no duplicate joins
                { association: 'Sections', separate: true, include: [{ association: 'MemberStudents', attributes: ['id'] }] }
                ]
            }]
        })

        let instructors = new Set(source.Class.Instructors.map(user => user.id))
        let tas = new Set(source.Class.ClassTAs.map(user => user.id))
        let globalSectionStudents = new Set(source.Class.GlobalSection.MemberStudents.map(user => user.id))
        let isUserInstructor = instructors.has(req.user.id);
        let isUserTA = tas.has(req.user.id);
        let isUserStudent = globalSectionStudents.has(req.user.id);

        if (!isUserInstructor && !isUserStudent && !isUserTA) {
            res.status(200).json([]);
            return;
        }

        let usersICanSee = []
        let isSingleSectionClass = source.Class.Sections.length === 1

        for (const section of source.Class.Sections) {
            let memberIds = section.MemberStudents.map(user => user.id)

            if ((isUserInstructor && section.is_global) || (isUserTA && section.is_global) || (isSingleSectionClass)) {
                usersICanSee = memberIds
                break;
            } else {
                if (memberIds.indexOf(req.user.id) >= 0 && !section.is_global) {
                    usersICanSee = memberIds
                    break
                }
            }
        }

        const location = await Location.create({ source_id: source.id })

        let htmlLoc; 
        if (req.body.drawAnnotationRect) {
            const rect = req.body.drawAnnotationRect
            const imageSvg = req.body.drawAnnotationSvg 
            htmlLoc = { start_node: imageSvg, end_node: imageSvg, start_offset: rect.x_offset, end_offset: rect.y_offset, width: rect.width, height: rect.height, location_id: location.id}
        } else {
            const range = req.body.range
            htmlLoc = { start_node: range.start, end_node: range.end, start_offset: range.startOffset, end_offset: range.endOffset, location_id: location.id }
        }

        if (req.body.videoAnnotationStartTime) {
            htmlLoc.start_time = req.body.videoAnnotationStartTime
            htmlLoc.end_time = req.body.videoAnnotationEndTime
        }

        const [htmlLocation, thread] = await Promise.all([
            HtmlLocation.create(htmlLoc),
            Thread.create({ location_id: location.id, HeadAnnotation: { content: body.content, visibility: body.visibility, anonymity: body.anonymity, author_id: req.user.id } }, { include: [{ association: 'HeadAnnotation' }] })
        ])

        const annotation = thread.HeadAnnotation;
        body.tags.forEach((tag) => Tag.create({ annotation_id: annotation.id, tag_type_id: tag }));
        body.userTags.forEach((user_id) => User.findByPk(user_id).then(user => annotation.addTaggedUser(user)));

        const user = await User.findByPk(req.user.id)
        if (body.replyRequest) annotation.addReplyRequester(user);
        if (body.star) annotation.addStarrer(user);
        if (body.bookmark) annotation.addBookmarker(user);
        thread.setSeenUsers([user]);
        thread.setRepliedUsers([user]);

        const annotationMedia = await AnnotationMedia.create({ type: body.type, filepath: filepath })
        await annotation.setThread(thread)
        await annotation.setMedia(annotationMedia)

        const annotationWithMedia = await Annotation.findByPk(annotation.id, { include: [{ association: 'Thread' }, { association: 'Media' }] })
        res.status(200).json(annotationWithMedia)

        const threadId = thread?.id
    
        if (threadId) {
            const io = socketapi.io
            const urlHash = crypto.createHash('md5').update(req.body.url).digest('hex');
            const globalRoomId = `${urlHash}:${req.body.class}`
            const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))
            const t = await fetchSpecificThread(req.body.class, req.body.url, threadId)
        
            if (annotation.visibility === 'INSTRUCTORS') {
                // Since instructors are only part of the global section, only emit to the global room
                io.to(globalRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors], taggedUsers: [...req.body.userTags] })
            } else if (annotation.visibility === 'EVERYONE') {
                io.to(globalRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors, ...tas, ...usersICanSee], taggedUsers: [...req.body.userTags] })
                classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_thread', { thread: t, authorId: req.user.id, userIds: [...instructors, ...tas, ...usersICanSee], taggedUsers: [...req.body.userTags] }))
            }
        }
    } catch (error) {
        console.error('\n\nannotations/media/annotation');
        console.error(error);
        res.status(500).json(error)
    }

});

async function fetchSpecificThread(classId, sourceUrl, threadId) {
    let classInstructors = new Set([])
    let classTAs = new Set([])

    try {
        const source = await Source.findOne({
            where: { [Op.and]: [{ filepath: sourceUrl }, { class_id: classId }] },
            include: [{
                association: 'Class',
                include: [
                    { association: 'Instructors', attributes: ['id'] },
                    { association: 'ClassTAs', attributes: ['id'] },
                ]
            }]
        })

        classInstructors = new Set(source.Class.Instructors.map(user => user.id)) // convert to set so faster to check if a user is in this set
        classTAs = new Set(source.Class.ClassTAs.map(user => user.id)) // convert to set so faster to check if a user is in this set
        
        const thread = await Thread.findOne({
            where: { id: threadId },
            include: [
                {
                    association: 'Location', include: [{ association: 'HtmlLocation' }],
                },
                {
                    association: 'HeadAnnotation', attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                    include: [
                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'TaggedUsers', attributes: ['id'] },
                        { association: 'Tags', attributes: ['tag_type_id'] },
                        { association: 'Bookmarkers', attributes: ['id'] },
                        { association: 'Spotlight', attributes: ['id', 'type'] },
                        { association: 'Media', attributes: ['filepath', 'type'] },
                    ]
                },
                {
                    association: 'AllAnnotations', separate: true, attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                    include: [
                        { association: 'Parent', attributes: ['id'] },
                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'TaggedUsers', attributes: ['id'] },
                        { association: 'Tags', attributes: ['tag_type_id'] },
                        { association: 'Bookmarkers', attributes: ['id'] },
                        { association: 'Media', attributes: ['filepath', 'type'] },
                    ]
                },
                { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                { association: 'RepliedUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
            ]
        })

        let annotations = {}
        let headAnnotation = utils.createAnnotationFromThread(thread.Location.HtmlLocation, thread.HeadAnnotation, thread.SeenUsers, classInstructors, classTAs)

        thread.AllAnnotations.forEach((annotation) => {
            if (annotation.Parent) {
                if (!(annotation.Parent.id in annotations)) {
                    annotations[annotation.Parent.id] = []
                }
                annotations[annotation.Parent.id].push(utils.createAnnotationFromThread(thread.Location.HtmlLocation, annotation, thread.SeenUsers, classInstructors, classTAs))
            }
        })
                            
        return { headAnnotation: headAnnotation, annotationsData: annotations }
    } catch(err) {
        console.log(err)
    }
}

/**
* Get a specific thread (+ respective reply annotations) for a given source
* Assume that the user requesting is authorized to view the thread (part of the section, and nt only visible to instructors/myself)
* @name GET/api/annotations/specific_thread
* @param source_url: source url
* @param class_id: source class id
* @param id: id of thread
*/
router.get('/specific_thread', async (req, res) => {
    let classInstructors = new Set([])
    let classTAs = new Set([])

    try {
        const follows = await Followers.findAll({ where: { user_id: req.user.id}})
        const source = await Source.findOne({
            where: { [Op.and]: [{ filepath: req.query.source_url }, { class_id: req.query.class_id }] },
            include: [{
                association: 'Class',
                include: [
                    { association: 'Instructors', attributes: ['id'] },
                    { association: 'ClassTAs', attributes: ['id'] },
                ]
            }]
        })

        classInstructors = new Set(source.Class.Instructors.map(user => user.id)) // convert to set so faster to check if a user is in this set
        classTAs = new Set(source.Class.ClassTAs.map(user => user.id)) // convert to set so faster to check if a user is in this set
        
        const thread = await Thread.findOne({
            where: { id: req.query.thread_id },
            include: [
                {
                    association: 'Location', include: [{ association: 'HtmlLocation' }],
                },
                {
                    association: 'HeadAnnotation', attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                    include: [
                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'TaggedUsers', attributes: ['id'] },
                        { association: 'Tags', attributes: ['tag_type_id'] },
                        { association: 'Bookmarkers', attributes: ['id'] },
                        { association: 'Spotlight', attributes: ['id', 'type'] },
                        { association: 'Media', attributes: ['filepath', 'type'] },
                    ]
                },
                {
                    association: 'AllAnnotations', separate: true, attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                    include: [
                        { association: 'Parent', attributes: ['id'] },
                        { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                        { association: 'TaggedUsers', attributes: ['id'] },
                        { association: 'Tags', attributes: ['tag_type_id'] },
                        { association: 'Bookmarkers', attributes: ['id'] },
                        { association: 'Media', attributes: ['filepath', 'type'] },
                    ]
                },
                { association: 'SeenUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                { association: 'RepliedUsers', attributes: ['id', 'first_name', 'last_name', 'username'] },
            ]
        })

        let annotations = {}
        let headAnnotation = utils.createAnnotationFromThread(thread.Location.HtmlLocation, thread.HeadAnnotation, thread.SeenUsers, classInstructors, classTAs, req.user.id, follows)

        thread.AllAnnotations.forEach((annotation) => {
            if (annotation.Parent) {
                if (!(annotation.Parent.id in annotations)) {
                    annotations[annotation.Parent.id] = []
                }
                annotations[annotation.Parent.id].push(utils.createAnnotationFromThread(thread.Location.HtmlLocation, annotation, thread.SeenUsers, classInstructors, classTAs, req.user.id, follows))
            }
        })
                            
        res.status(200).json({ 'headAnnotation': headAnnotation, 'annotationsData': annotations });
    } catch(err) {
        console.log(err)
        res.status(res.status(400).json({ msg: "Error fetching specific thread" }))
    }
})



/**
* Get all reply annotation for a given parent
* @name GET/api/annotations/reply/:id
* @param id: parent id
* @return [{
* id: id of annotation
* content: text content of annotation,
* range: json for location range,
* author: id of author,
* tags: list of ids of tag types,
* userTags: list of ids of users tagged,
* visibility: string enum,
* anonymity: string enum,
* replyRequest: boolean,
* star: boolean
* }]
*/
router.get('/reply/:id', (req, res) => {
    Annotation.findByPk(req.params.id, {
        include: [{
            association: 'Thread', attributes: ['id'],
            include: [{
                association: 'Location', attributes: ['id'],
                include: [{
                    association: 'Source', attributes: ['id'],
                    include: [{
                        association: 'Class', attributes: ['id'],
                        include: [{ association: 'Instructors', attributes: ['id'] }]
                    }]
                }]
            }]
        }]
    })
        .then(parent => parent.Thread.Location.Source.Class.Instructors.map(user => user.id))
        .then(instructors => {
            Annotation.findAll({
                where: { parent_id: req.params.id },
                attributes: ['id', 'content', 'visibility', 'anonymity', 'created_at', 'endorsed'],
                include: [
                    { association: 'Thread', include: [{ association: 'SeenUsers' }] },
                    { association: 'Author', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'ReplyRequesters', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'Starrers', attributes: ['id', 'first_name', 'last_name', 'username'] },
                    { association: 'TaggedUsers', attributes: ['id'] },
                    { association: 'Tags', attributes: ['tag_type_id'] },
                    { association: 'Bookmarkers', attributes: ['id'] }
                ]
            })
                .then(annotations => {
                    let isUserInstructor = instructors.indexOf(req.user.id) >= 0;
                    return annotations
                        .filter(annotation => {
                            if (annotation.visibility === 'MYSELF'
                                && annotation.Author.id !== req.user.id) {
                                return false;
                            }
                            if (annotation.visibility === 'INSTRUCTORS' && !isUserInstructor) {
                                return false;
                            }
                            return true;
                        })
                        .map(annotation => {
                            let reply = {};
                            reply.id = annotation.id;
                            reply.range = null;
                            reply.parent = req.params.id;
                            reply.timestamp = annotation.dataValues.created_at;
                            reply.author = annotation.Author.id;
                            reply.authorName = annotation.Author.first_name + " " + annotation.Author.last_name;
                            reply.instructor = instructors.indexOf(annotation.Author.id) >= 0;
                            reply.html = annotation.content;
                            reply.hashtags = annotation.Tags.map(tag => tag.tag_type_id);
                            reply.people = annotation.TaggedUsers.map(userTag => userTag.id);
                            reply.visibility = annotation.visibility;
                            reply.anonymity = annotation.anonymity;
                            reply.replyRequestedByMe = annotation.ReplyRequesters
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.replyRequestCount = annotation.ReplyRequesters.length;
                            reply.starredByMe = annotation.Starrers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.starCount = annotation.Starrers.length;
                            reply.seenByMe = annotation.Thread.SeenUsers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            reply.bookmarked = annotation.Bookmarkers
                                .reduce((bool, user) => bool || user.id == req.user.id, false);
                            return reply;
                        });
                })
                .then(annotations => res.status(200).json(annotations));
        });


});

/**
* Make new reply for a given annotation and emit socket io message
* @name POST/api/annotations/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
*/
router.post('/reply/:id', async (req, res) => {
    const parent = await Annotation.findByPk(req.params.id, { 
        include: [{ association: 'Thread', 
            include: [{ association: 'HeadAnnotation', attributes: ['id'] }, { association: 'AllAnnotations', include: [{association: 'Author'}]
        }] 
    }] })

    const child = await Annotation.create({
            content: req.body.content,
            visibility: req.body.visibility,
            anonymity: req.body.anonymity,
            thread_id: parent.Thread.id,
            author_id: req.user.id,
            Tags: req.body.tags.map(tag_type => { return { tag_type_id: tag_type }; }),
        }, {
            include: [{ association: 'Tags' }]
        })
        
    req.body.userTags.forEach(user_id => User.findByPk(user_id).then(user => child.addTaggedUser(user)));
    
    const user = await User.findByPk(req.user.id)

    if (req.body.replyRequest) child.addReplyRequester(user);
    if (req.body.star) child.addStarrer(user);
    if (req.body.bookmark) child.addBookmarker(user);
    parent.Thread.setSeenUsers([user]);
    parent.Thread.setRepliedUsers([user]);
    const t = await fetchSpecificThread(req.body.class, req.body.url, parent.Thread.id)
    const io = socketapi.io
    const urlHash = crypto.createHash('md5').update(req.body.url).digest('hex')
    const globalRoomId = `${urlHash}:${req.body.class}`
    const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))

    io.to(globalRoomId).emit('new_reply', { thread: t, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id })
    classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_reply', { thread: t, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id }))
 
    parent.addChild(child);
    res.status(200).json(child);

    if (child.visibility === 'EVERYONE') {
        const MAX_TEXT_LENGTH = 160
        const threadText = parent.content
        const replyAuthor = child.anonymity === 'ANONYMOUS' ? 'Anonymous' : user.username
        const replyTextClean = child.content.replace(/<\/?[^>]+(>|$)/g, "")
        const replyText = replyTextClean.length > MAX_TEXT_LENGTH ? replyTextClean.substring(0, MAX_TEXT_LENGTH - 3) + "..." : replyTextClean
        const replyUrl = `${req.body.url}#nb-comment-${parent.Thread.HeadAnnotation.id}`
        const emailType = 'NEWREPLY'

        const emails = {}
        parent.Thread.AllAnnotations.forEach(a => emails[a.author_id] = a.Author.email)

        const usersToNotify = Array.from( new Set(
            parent.Thread.AllAnnotations
            .filter(a => a.visibility !== 'MYSELF' && a.author_id !== child.author_id )
            .map(a => a.author_id) 
        ))

        for (const u of usersToNotify) {
            const email = new EmailUtil().to(emails[u]).subject(`[NB] New reply from ${replyAuthor}`).userId(u).emailType(emailType).html(EmailTemplate.buildThreadNewReplyEmail(u, emailType, replyAuthor, replyUrl, replyText))

            try {
                await email.send()
            } catch (error) {
               console.error(error.message);
            }
        }
       
    }
});

/**
* Make new reply for a given annotation and emit socket io message
* @name POST/api/annotations/media/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param author: id of author
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
* @param star: boolean
*/
router.post('/media/reply/:id', upload.single("file"), async (req, res) => {
    try {
        const filepath = `/media/${req.file.filename}`
        const body = JSON.parse(req.body.annotation)
        const parent = await Annotation.findByPk(req.params.id, { include: [{ association: 'Thread', include: [{ association: 'HeadAnnotation', attributes: ['id'] }] }] })
        const child = await Annotation.create({ content: body.content, visibility: body.visibility, anonymity: body.anonymity, thread_id: parent.Thread.id, author_id: req.user.id, Tags: body.tags.map(tag_type => { return { tag_type_id: tag_type }; }), }, { include: [{ association: 'Tags' }] })
        body.userTags.forEach(user_id => User.findByPk(user_id).then(user => child.addTaggedUser(user)));
        const user = await User.findByPk(req.user.id)
        if (body.replyRequest) child.addReplyRequester(user);
        if (body.star) child.addStarrer(user);
        if (body.bookmark) child.addBookmarker(user);
        parent.Thread.setSeenUsers([user]);
        parent.Thread.setRepliedUsers([user]);

        const annotationMedia = await AnnotationMedia.create({ type: body.type, filepath: filepath })
        await child.setMedia(annotationMedia)

        const childWithMedia = await Annotation.findByPk(child.id, { include: [{ association: 'Thread' }, { association: 'Media' }] })

        const t = await fetchSpecificThread(req.body.class, req.body.url, parent.Thread.id)
        const io = socketapi.io
        const urlHash = crypto.createHash('md5').update(body.url).digest('hex')
        const globalRoomId = `${urlHash}:${body.class}`
        const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))
        
        io.to(globalRoomId).emit('new_reply', { thread: t, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id })
        classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('new_reply', { thread: t, authorId: req.user.id, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id, taggedUsers: [...req.body.userTags], newAnnotationId: child.id }))

        parent.addChild(child);
        res.status(200).json(childWithMedia);
    } catch (error) {
        console.error('\n\nannotations/media/reply');
        console.error(error);
        res.status(500).json(error)
    }

});

/**
* Edit a given annotation
* @name GET/api/annotations/reply/:id
* @param id: id of parent annotation
* @param content: text content of annotation
* @param tags: list of ids of tag types
* @param userTags: list of ids of users tagged
* @param visibility: string enum
* @param anonymity: string enum
* @param replyRequest: boolean
*/
router.put('/annotation/:id', async (req, res) => {
    const annotation = await Annotation.findByPk(req.params.id)
    const parent = await Annotation.findByPk(req.params.id, { include: [{ association: 'Thread', include: [{ association: 'HeadAnnotation', attributes: ['id'] }] }] })
    await annotation.update({ content: req.body.content, visibility: req.body.visibility, anonymity: req.body.anonymity, endorsed: req.body.endorsed})
    await Tag.destroy({ where: { annotation_id: annotation.id } })
          
    if (req.body.userTags && req.body.userTags.length) {
        const users = await Promise.all(req.body.userTags.map(user_id => User.findByPk(user_id)))
        annotation.setTaggedUsers(users)
    }
          
    if (req.body.tags && req.body.tags.length) {
        const tags = await Promise.all(req.body.tags.map(tag => Tag.create({ annotation_id: annotation.id, tag_type_id: tag })))
        annotation.setTags(tags)
    }

    const user = await User.findByPk(req.user.id)

    if (req.body.replyRequest) {
        await annotation.addReplyRequester(user);
    } else {
        await annotation.removeReplyRequester(user);
    }

    if (req.body.upvotedByMe && req.body.upvotedByMe === true) {
        await annotation.addStarrer(user);
    } else if (req.body.upvotedByMe && req.body.upvotedByMe === false) {
        await annotation.removeStarrer(user);
    }

    await emitThreadUpdate(req.body.class, req.body.url, parent.Thread.id, req.user.id, parent)
    res.sendStatus(200)
});

async function emitThreadUpdate(classId, url, threadId, userId, parent) {
    const t = await fetchSpecificThread(classId, url, threadId)
    const io = socketapi.io
    const urlHash = crypto.createHash('md5').update(url).digest('hex')
    const globalRoomId = `${urlHash}:${classId}`
    const classSectionRooms = Array.from(io.sockets.adapter.rooms.keys()).filter(c => c.startsWith(`${globalRoomId}:`))

    io.to(globalRoomId).emit('update_thread', { thread: t, authorId: userId, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id})
    classSectionRooms.forEach(sectionRoomId => io.to(sectionRoomId).emit('update_thread', { thread: t, authorId: userId, threadId: parent.Thread.id, headAnnotationId: parent.Thread.HeadAnnotation.id}))
}

/**
* Deletes a given annotation
* @name DELETE/api/annotations/annotation/:id
* @param id: id of annotation
*/
router.delete('/annotation/:id', (req, res) => {
    Annotation.findByPk(req.params.id, {
        include: [
            { association: 'Thread', include: [{ association: 'Location' }] },
            { association: 'Parent' }
        ]
    })
        .then(annotation => {
            annotation.destroy();
            if (!annotation.Parent) {
                annotation.Thread.destroy();
                annotation.Thread.Location.destroy();
            }

        })
        .then(() => res.sendStatus(200))
        .catch((err) => res.sendStatus(400));
});

/**
* Sets seen for a given annotation and user
* @name POST/api/annotations/seen/:id
* @param id: id of annotation
*/
router.post('/seen/:id', async (req, res) => {
    try {
        const [annotation, user] = await Promise.all([
            Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] }),
            User.findByPk(req.user.id)
        ])

        await annotation.Thread.removeSeenUser(user)
        await annotation.Thread.addSeenUser(user)
        res.sendStatus(200)
    } catch (error) {
        res.sendStatus(400)
    }
});

/**
* Toggles a star for a given annotation
* @name POST/api/annotations/star/:id
* @param id: id of annotation
*/
router.post('/star/:id', async (req, res) => {
    try {
        const annotation = await Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] })
        const user = await User.findByPk(req.user.id)
        
        if (req.body.star) {
            await annotation.addStarrer(user); 
        } else { 
            await annotation.removeStarrer(user);
        }
        
        await annotation.Thread.removeSeenUser(user)
        await annotation.Thread.addSeenUser(user)
        await annotation.Thread.removeRepliedUser(user)
        await annotation.Thread.addRepliedUser(user)

        console.log(req.body);
        const parent = await Annotation.findByPk(req.params.id, { include: [{ association: 'Thread', include: [{ association: 'HeadAnnotation', attributes: ['id'] }] }] })
        await emitThreadUpdate(req.body.class, req.body.url, parent.Thread.id, req.user.id, parent)

        res.sendStatus(200)
    } catch (error) {
        console.log(error)
        res.sendStatus(400)
    }
});

/**
* Toggles a replyRequest for a given annotation
* @name POST/api/annotations/replyRequest/:id
* @param id: id of annotation
*/
router.post('/replyRequest/:id', (req, res) => {
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            if (req.body.replyRequest) { annotation.addReplyRequester(user); }
            else { annotation.removeReplyRequester(user); }
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            annotation.Thread.removeRepliedUser(user).then(() => {
                annotation.Thread.addRepliedUser(user)
            })
        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))
    );
});

/**
* Toggles a bookmark for a given annotation
* @name POST/api/annotations/bookmark/:id
* @param id: id of annotation
*/
router.post('/bookmark/:id', (req, res) => {
    Annotation.findByPk(req.params.id, { include: [{ association: 'Thread' }] }).then(annotation =>
        User.findByPk(req.user.id).then(user => {
            if (req.body.bookmark) { annotation.addBookmarker(user); }
            else { annotation.removeBookmarker(user); }
            annotation.Thread.removeSeenUser(user).then(() => {
                annotation.Thread.addSeenUser(user)
            })
            annotation.Thread.removeRepliedUser(user).then(() => {
                annotation.Thread.addRepliedUser(user)
            })
        }).then(() => res.sendStatus(200))
            .catch((err) => res.sendStatus(400))

    );
});


function simplifyUser(user, role) {
    const id = user.id;
    user = user.get({ plain: true });
    user.id = id;
    user.name = { first: user.first_name, last: user.last_name };
    user.role = role;
    return user;
}


module.exports = router;

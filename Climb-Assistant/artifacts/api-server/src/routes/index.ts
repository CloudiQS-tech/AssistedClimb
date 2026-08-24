import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import teacherRouter from "./teacher/index";
import studentRouter from "./student/index";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(teacherRouter);
router.use(studentRouter);
router.use(adminRouter);

export default router;

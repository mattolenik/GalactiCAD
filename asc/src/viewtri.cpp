/*
 *
 * Copyright (c) Tien-Tsin Wong, 1996.  
 * All Right Reserved.
 *
 * viewtri 
 * An interactive program to view a set of triangular mesh.
 * Mainly modified from the "dinospin.c" by Mark J. Kiligard.
 * This program makes use of the "trackball.c" from SGI.
 *
 */

#ifdef WIN32
#include <windows.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>  
#include <GL/gl.h>    
#include <GL/glu.h>
#include <GL/glut.h>
#include "trackball.h"
#include "vecmath.h"
#include "common.h"

#define MAXTRI 600000
#define MAXVER (3*MAXTRI)   /* for simple development, this is the limit */

#define BUFLEN 1000

#define TPOLY  	     1
#define RENDERMAN    2
#define TRIBINARY    3  /* my own triangle binary format          */
#define TRIBINARY2   4  /* triangle binary format used by Dr Heng */

/* Mode of working with left mouse button */
#define ROTATE	     0
#define ZOOM         1
#define TRANSLATE    2
#define FOV          3

/******************************* Global Variables ***************************/
/* Global variables */
int G_rightbuttonmenu;
char G_mode=ROTATE;  /* mode of working with left mouse button */
char G_filetype=TPOLY, G_filename[256];
int G_NormalObj=1, G_BoxObj=2, G_Wireframe=3;
float *G_Vertex, *G_Normal;
long G_FastTriLimit=50000; /* The max no of triangles which this program can still play fast */
long G_TriCnt=0;
char G_allflip = FALSE;
char G_cullface = TRUE;
char G_smoothshade=TRUE;
char G_flipnormal=FALSE;
char G_drawwireframe=FALSE;
char G_lightZeroSwitch=TRUE, G_lightOneSwitch=TRUE;
char G_spinning=FALSE, G_dragging=FALSE;
char G_newModel=TRUE;
char G_recordtransform=FALSE;
int G_currx, G_curry, G_startx, G_starty, G_lastx, G_lasty;
int G_W = 300, G_H = 300, G_halfW = 150, G_halfH = 150;
float G_curquat[4];
float G_lastquat[4];
float G_scale=1.0, G_oldscale=1.0, G_zoomvector[2];
float G_pan[2], G_fov=40.0, G_oldfov=40.0;
float G_RecordScale, G_RecordTranslateX, G_RecordTranslateY, G_RecordTranslateZ;
float G_EXScale=1.0, G_EYScale=1.0, G_EZScale=1.0;
char G_EnableEScale=TRUE;

GLfloat G_lightZeroPosition[] = {0.0, 1.0, 1.0, 0.0}; /* directional */ /*{10.0, 4.0, 10.0, 1.0};*/
GLfloat G_lightZeroColor[] = {0.9, 1.0, 0.9, 1.0}; /* green-tinted */
GLfloat G_lightOnePosition[] = {-1.0, -2.0, 1.0, 0.0};
GLfloat G_lightOneColor[] = {0.9, 0.6, 0.3, 1.0}; /* red-tinted */
GLfloat G_skinColor[] = {1.0, 1.0, 1.0, 1.0};
GLfloat mat_amb[4] = {0.05, 0.0, 0.0, 1.0}; 
GLfloat mat_diff[4] = {0.5, 0.4, 0.4, 1.0};
GLfloat mat_spec[4] = {0.7, 0.4, 0.4, 1.0};


/*********************** Function Prototype ******************************/
void SaveRGBImage(char *filename);


/************************** Function Implementation ************************/
void ReadTPoly(char *filename, float *min, float *max, char *withnormal)
{
  FILE *fptr;
  char buffer[BUFLEN], *eoftest;
  int i, j;
  long offset;

  if ((fptr=fopen(filename,"rt"))==NULL)
  {
    fprintf(stderr, "Cannot open tpoly file\n");
    exit(1);
  }
  /* assume the data file is correct and error free */
  *withnormal = TRUE;
  eoftest = buffer;
  while (G_TriCnt<MAXTRI && eoftest!=NULL)
  {
    if (G_TriCnt%1000==0)
      fprintf(stderr, "Read in %d triangles\n", G_TriCnt);
    if (fgets(buffer, BUFLEN, fptr)==NULL)
      break; /* eof */
    for (i=0 ; i<3 ; i++)
    {
      if ((eoftest=fgets(buffer, BUFLEN, fptr))==NULL)
	break; /* eof */
      offset = 9*G_TriCnt + 3*i;
      sscanf(buffer, "%f %f %f %f %f %f",
	     &(G_Vertex[offset]), &(G_Vertex[offset+1]), &(G_Vertex[offset+2]),
	     &(G_Normal[offset]), &(G_Normal[offset+1]), &(G_Normal[offset+2]));
      for (j=0 ; j<3 ; j++) /* Find the bounding box */
      {
	if (G_Vertex[offset+j] > max[j])
	  max[j] = G_Vertex[offset+j];
	if (G_Vertex[offset+j] < min[j])
	  min[j] = G_Vertex[offset+j];
      }
    }
    G_TriCnt++;
  }
  fclose(fptr);
}


#define RR_RIB       1
#define RR_P         2
#define RR_N         3
void ReadRib(char *filename, float *min, float *max, char *withnormal)
{
  char buffer[BUFLEN], *eoftest, *token, *buf, mode;
  int i, j, c;
  long offset;
  FILE *fptr;

  if ((fptr=fopen(filename,"rt"))==NULL)
  {
    fprintf(stderr, "Cannot open rib file\n");
    exit(1);
  }
  /* assume the data file is correct and error free */
  *withnormal = FALSE;
  eoftest = buffer;
  mode = RR_RIB;
  while (G_TriCnt<MAXTRI && eoftest!=NULL)
  {
    if (fgets(buffer, BUFLEN, fptr)==NULL)
      break; /* eof */

    buf = buffer;
    while (TRUE)
    {
      if ((token=strtok(buf,"\n\t ,[]\""))==NULL) /* no more token */
	break;
      if (buf!=NULL)
	buf = NULL;
      switch(mode)
      {
	case RR_RIB: /*after "Polygon" before "P" and "N" */
	  if (strcmp(token, "P")==0)
	    mode = RR_P;
	  else if (strcmp(token, "N")==0)
	    mode = RR_N;
	  else if (strcmp(token, "Polygon")==0)
	  {
	    if (G_TriCnt%1000==0)
	      fprintf(stderr, "Read in %d triangles\n", G_TriCnt);
	    G_TriCnt++;
	  }
	  i=0;
	  break;
	case RR_P: /* read vertex */
	  offset = (G_TriCnt-1)*9;
	  c = i%3;
	  G_Vertex[offset+i] = atof(token);
	  if (G_Vertex[offset+i] > max[c])
	    max[c] = G_Vertex[offset+i];
	  if (G_Vertex[offset+i] < min[c])
	    min[c] = G_Vertex[offset+i];
	  i++;
	  if (i>=9) /* one triangle read */
	  { i = 0; mode = RR_RIB; }
	  break;
	case RR_N: /* read normal */
	  *withnormal=TRUE;
	  G_Normal[(G_TriCnt-1)*9+i] = atof(token);
	  i++;
	  if (i>=9) /* one triangle read */
	  { i = 0; mode = RR_RIB; }
	  break;
      }
    }
  }
  fclose(fptr);
}


#define TRIBLOCK 1000
void ReadBin(char *filename, float *min, float *max, char *withnormal, char version)
{
  FILE *fptr;
  char *buffer, *eoftest;
  int i, j, idx, maxidx;
  long offset, itemread;
  float *fbuffer;

  if ((fptr=fopen(filename,"rb"))==NULL)
  {
    fprintf(stderr, "Cannot open triangle binary file\n");
    exit(1);
  }

  if (version==TRIBINARY2) /* skip bytes */
    fseek(fptr, sizeof(int)+sizeof(double)*6, SEEK_SET); /* skip 1 int and 6 double */

  /* assume the data file is correct and error free */
  *withnormal = TRUE;
  eoftest = buffer;
  if ((buffer=(char*)malloc(sizeof(float)*18*TRIBLOCK))==NULL)
  {
    fprintf(stderr,"[ReadBin]: no memory for buffer\n");
    exit(1);
  }
  fbuffer = (float*)buffer;
  offset = 9*G_TriCnt;
  while (G_TriCnt<MAXTRI)
  {
    if ((itemread=cp_fread(buffer, sizeof(float), 18*TRIBLOCK, fptr))==0)
      break; /* eof */
    fprintf(stderr, "Read in %d triangles\n", G_TriCnt);
    idx = 0;
    maxidx = itemread;
    while (idx<maxidx && G_TriCnt<MAXTRI)
    {
      for (i=0 ; i<3 ; i++)
      {
	for (j=0 ; j<3 ; j++, offset++, idx++)
	{
	  G_Vertex[offset] = fbuffer[idx];
	  if (G_Vertex[offset] > max[j])
	    max[j] = G_Vertex[offset];
	  if (G_Vertex[offset] < min[j])
	    min[j] = G_Vertex[offset];
	}
        offset -= 3;
	for (j=0 ; j<3 ; j++, offset++, idx++)
	  G_Normal[offset] = fbuffer[idx];
      }
      G_TriCnt++;
    }
  }
  fclose(fptr);
  free(buffer);
  if (G_Normal[0]==0 && G_Normal[1]==0 && G_Normal[2]==0)
    *withnormal = FALSE; /* no normal given */
  printf("withnormal=%d\n", *withnormal);
}



/* drawbox:
 *
 * draws a rectangular box with the given x, y, and z ranges.  
 * The box is axis-aligned.
 */
void drawbox(GLdouble x0, GLdouble x1, GLdouble y0, GLdouble y1,
	     GLdouble z0, GLdouble z1, GLenum type)
{
    static GLdouble n[6][3] = {
	{-1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {1.0, 0.0, 0.0},
	{0.0, -1.0, 0.0}, {0.0, 0.0, 1.0}, {0.0, 0.0, -1.0}
    };
    static GLint faces[6][4] = {
	{ 0, 1, 2, 3 }, { 3, 2, 6, 7 }, { 7, 6, 5, 4 },
	{ 4, 5, 1, 0 }, { 5, 6, 2, 1 }, { 7, 4, 0, 3 }
    };
    GLdouble v[8][3], tmp;
    GLint i;

    if (x0 > x1) {
	tmp = x0; x0 = x1; x1 = tmp;
    }
    if (y0 > y1) {
	tmp = y0; y0 = y1; y1 = tmp; 
    }
    if (z0 > z1) {
	tmp = z0; z0 = z1; z1 = tmp; 
    }
    v[0][0] = v[1][0] = v[2][0] = v[3][0] = x0;
    v[4][0] = v[5][0] = v[6][0] = v[7][0] = x1;
    v[0][1] = v[1][1] = v[4][1] = v[5][1] = y0;
    v[2][1] = v[3][1] = v[6][1] = v[7][1] = y1;
    v[0][2] = v[3][2] = v[4][2] = v[7][2] = z0;
    v[1][2] = v[2][2] = v[5][2] = v[6][2] = z1;

    for (i = 0; i < 6; i++) {
	glBegin(type);
	glNormal3dv(&n[i][0]);
	glVertex3dv(&v[faces[i][0]][0]);
	glNormal3dv(&n[i][0]);
	glVertex3dv(&v[faces[i][1]][0]);
	glNormal3dv(&n[i][0]);
	glVertex3dv(&v[faces[i][2]][0]);
	glNormal3dv(&n[i][0]);
	glVertex3dv(&v[faces[i][3]][0]);
	glEnd();
    }
}


char InitModel(char *filename, char filetype)
{
  int i, j, k;
  float v1[3], v2[3], *vv, *nn, max[3], min[3], len;
  float *p;
  long idx;
  char withnormal;

  if ((G_Vertex=(float*)malloc(sizeof(float)*3*(MAXVER+5)))==NULL
  ||  (G_Normal=(float*)malloc(sizeof(float)*3*(MAXVER+5)))==NULL)
  {
    fprintf(stderr, "No memory for G_Vertex and G_Normal\n");
    exit(1);
  }
  
  /* Clear the G_Normal[] to zero */
  for (idx=0, p=G_Normal ; idx<MAXTRI*9 ; idx++, p++)
    *p = 0;
  withnormal = FALSE;
  G_TriCnt = 0;
  max[0] = max[1] = max[2] = -10000;
  min[0] = min[1] = min[2] = 10000;
  switch (filetype)
  {
    case TPOLY:      ReadTPoly(filename, min, max, &withnormal);          break;
    case RENDERMAN:  ReadRib(filename, min, max, &withnormal);            break;
    case TRIBINARY:  ReadBin(filename, min, max, &withnormal, filetype);  break;
    case TRIBINARY2: ReadBin(filename, min, max, &withnormal, filetype);  break;
  }
  fprintf (stderr, "Total no of triangle read into memory: %d\n", G_TriCnt);
  fprintf (stderr, "Extent: X[%8.5f-%8.5f] Y[%8.5f-%8.5f] Z[%8.5f-%8.5f]\n", 
  	   min[0], max[0], min[1], max[1], min[2], max[2]);
  len = 0;
  for (j=0 ; j<3 ; j++)
    if (len < max[j]-min[j])
      len = max[j]-min[j];
  len = 2.0/len;

  /* construct the normal one */
  glNewList(G_NormalObj, GL_COMPILE);
  glPushMatrix();
  if (G_EnableEScale)
    glScalef(len*G_EXScale, len*G_EYScale, len*G_EZScale); /* scale to range [-1, 1] */ 
  else 
    glScalef(len, len, len); /* scale to range [-1, 1] */ 
  glTranslatef(-(min[0]+max[0])/2.0, -(min[1]+max[1])/2.0, -(min[2]+max[2])/2.0); 
  G_RecordScale = len;
  G_RecordTranslateX = -(min[0]+max[0])/2.0;  /* Record the scale and translate  */
  G_RecordTranslateY = -(min[1]+max[1])/2.0;  /* for later use -- output to file */
  G_RecordTranslateZ = -(min[2]+max[2])/2.0;
  glMaterialfv(GL_FRONT_AND_BACK, GL_DIFFUSE, G_skinColor);
  glBegin(GL_TRIANGLES);
    for (i=0, vv=G_Vertex, nn=G_Normal ; i<G_TriCnt*3 ; i++, vv+=3, nn+=3)
    {
      if (!withnormal && i%3==0) /* for each triangle calculate the normal using vertex */
      {  /* if no normal provided, calculate myself, since OpenGL cannot flat shade correctly if no normal given */
        k=0;
        do 
        {
          vsub(vv+k*3,         vv+((k+1)%3)*3, v1);  /* ccw order */
          vsub(vv+((k+2)%3)*3, vv+((k+1)%3)*3, v2);
          vcross(v2, v1, nn);
          if (vlength(nn)>0.00000000001)  /* not too small to do normalization */
          {
            vnormal(nn);
            break;
          }
          if (k==2)  /* still cannot find suitable normal due to degenerate triangle */
          {
            fprintf(stderr, "Degenerate triangle, arbitrary normal assummed\n");
            fprintf(stderr, "v1: %f %f %f\n", *vv, *(vv+1), *(vv+2));
            fprintf(stderr, "v2: %f %f %f\n", *(vv+3), *(vv+4), *(vv+5));
            fprintf(stderr, "v3: %f %f %f\n", *(vv+6), *(vv+7), *(vv+8));
            vset(nn, 0, 0, 1);
            break;
          }
          k++;
        } while (TRUE);
        vcopy(nn, nn+3);
        vcopy(nn, nn+6);
      }
      if (G_allflip)
        vscale(nn, -1.0); /* flip all input normal */
      glNormal3fv(nn);
      glVertex3fv(vv);
    }
  glEnd();
  glPopMatrix();
  glEndList();


  /* construct the wireframe version */
  glNewList(G_Wireframe, GL_COMPILE);
  glPushMatrix();
  glScalef(len, len, len); /* scale to range [-1, 1] */ 
  glTranslatef(-(min[0]+max[0])/2.0, -(min[1]+max[1])/2.0, -(min[2]+max[2])/2.0); 
  G_RecordScale = len;
  G_RecordTranslateX = -(min[0]+max[0])/2.0;  /* Record the scale and translate  */
  G_RecordTranslateY = -(min[1]+max[1])/2.0;  /* for later use -- output to file */
  G_RecordTranslateZ = -(min[2]+max[2])/2.0;
  for (i=0, vv=G_Vertex ; i<G_TriCnt*3 ; i++, vv+=3)
  {
    if (i%3==0)
      glBegin(GL_LINE_LOOP);
    glVertex3fv(vv);
    if (i%3==2)
      glEnd();
  }
  glPopMatrix();
  glEndList();

  free(G_Normal);
  free(G_Vertex);
  
  /* Create a rectangular box for dragging */
  glNewList(G_BoxObj, GL_COMPILE);
  glPushMatrix();
  glScalef(len, len, len); /* scale to range [-1, 1] */
  glMaterialfv(GL_FRONT, GL_DIFFUSE, G_skinColor);
  drawbox(-(min[0]+max[0])/2.0, (min[0]+max[0])/2.0, 
          -(min[1]+max[1])/2.0, (min[1]+max[1])/2.0,
          -(min[2]+max[2])/2.0, (min[2]+max[2])/2.0, GL_QUADS);
  glPopMatrix();
  glEndList();
  
  return withnormal;
}




void showMessage(GLfloat x, GLfloat y, GLfloat z, char *message)
{
  glPushMatrix();
  glDisable(GL_LIGHTING);
  glTranslatef(x, y, z);
  glScalef(.02, .02, .02);
  while (*message) {
    glutStrokeCharacter(GLUT_STROKE_ROMAN, *message);
    message++;
  }
  glEnable(GL_LIGHTING);
  glPopMatrix();
}


void RecordTransform()
{
  FILE *fptr;
  int i;
  GLfloat matrix[16];
  GLint viewport[4];
  
  if ((fptr=fopen("transfrm.txt", "wb"))==NULL)
  {
    fprintf(stderr, "Cannot write text transformation file transform.txt\n");
    G_recordtransform = FALSE;
    return;
  }
  glPushMatrix();  /* Do transformation inside the display list */
  glScalef(G_RecordScale, G_RecordScale, G_RecordScale);
  glTranslatef(G_RecordTranslateX, G_RecordTranslateY, G_RecordTranslateZ);
  glGetFloatv(GL_MODELVIEW_MATRIX, matrix);
  fprintf(fptr, "ModelViewMatrix");
  for (i=0 ; i<16 ; i++)
    fprintf(fptr," %f", matrix[i]);
  glGetFloatv(GL_PROJECTION_MATRIX, matrix);
  fprintf(fptr, "\nProjectionMatrix");
  for (i=0 ; i<16 ; i++)
    fprintf(fptr," %f", matrix[i]);  
  glGetIntegerv(GL_VIEWPORT, viewport);
  fprintf(fptr, "\nViewport");
  for (i=0 ; i<4 ; i++)
    fprintf(fptr, " %d", viewport[i]);
  glGetFloatv(GL_DEPTH_RANGE, matrix);
  fprintf(fptr, "\nDepthRange");
  for(i=0 ; i<2 ; i++)
    fprintf(fptr, " %f", matrix[i]);

  G_recordtransform = FALSE;
  glPopMatrix();
  fclose(fptr);
}



void redraw(void)
{
  /* Clear screen & buffers */
  glClearColor(0.6, 0.6, 0.8, 0.0);  
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

  glMatrixMode(GL_PROJECTION);
  glPopMatrix();
  glPushMatrix();
  glTranslatef(G_pan[0], G_pan[1], 0);
  glMatrixMode(GL_MODELVIEW);
  if (G_newModel)
  {
    GLfloat m[4][4];
    glPopMatrix();  /* reset to original */
    glPushMatrix(); 
/*    glTranslatef(G_pan[0], G_pan[1], 0); /* Panning */
    build_rotmatrix(m, G_curquat);
    glMultMatrixf(&m[0][0]);
    glScalef(6,6,6);
    G_newModel = FALSE;
    glPushMatrix();
  }
  else
  {
    glPushMatrix();
/*    glTranslatef(G_pan[0], G_pan[1], 0); /* Panning */
  }
  glScalef(G_scale, G_scale, G_scale);
  if (G_recordtransform)
    RecordTransform();
  if (G_dragging && G_TriCnt>G_FastTriLimit)
    glCallList(G_NormalObj);
  else
  {
    glCallList(G_NormalObj); 
    if (G_drawwireframe)
    {
      glDepthFunc(GL_LEQUAL);
      glDisable(GL_LIGHTING);
      glColor4f(0, 0, 0, 1.0);
      glLineWidth(1);
      glEnable(GL_LINE_SMOOTH);
      glEnable(GL_BLEND);
      glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
      glHint(GL_LINE_SMOOTH_HINT, GL_NICEST);
      glCallList(G_Wireframe); 
      glEnable(GL_LIGHTING);
      glDepthFunc(GL_LESS);  /* assume this is default value */
      glDisable(GL_LINE_SMOOTH);
      glDisable(GL_BLEND);
    }
  }
  glPopMatrix();
  glutSwapBuffers();
}



void animate(void)
{
  add_quats(G_lastquat, G_curquat, G_curquat);
  G_newModel = TRUE;
  glutPostRedisplay();
}




void mouse(int button, int state, int x, int y)
{
  if (button == GLUT_LEFT_BUTTON)
  {
    if (state == GLUT_DOWN) 
    {
      G_spinning = FALSE;
      glutIdleFunc(NULL);
      G_dragging = TRUE;
      G_currx = x;
      G_curry = y;
      G_startx = x;
      G_starty = y;
      if (G_mode==ZOOM || G_mode==FOV)
      {
        G_zoomvector[0] = x - G_halfW;
        G_zoomvector[1] = y - G_halfH;
        if (G_zoomvector[0]==0 && G_zoomvector[1]==0) 
          G_zoomvector[0] = G_zoomvector[1] = 1.0;
      }
      if (G_mode==TRANSLATE)
      {
        G_lastx = x;
        G_lasty = y;
      }
    }
    else if (state == GLUT_UP) 
    {
      G_dragging = FALSE;
      if (G_mode==ZOOM)  /* Stop object continue to zoom in zoom mode */
      {
        glutIdleFunc(NULL);
        G_oldscale = G_scale;
      }
      if (G_mode==FOV) 
      {
        glutIdleFunc(NULL);
        G_oldfov = G_fov;
      }
      else if (G_mode==ROTATE)
      {
        if (G_startx == x && G_starty == y)  /* user click to stop spining */
        {
          G_spinning = FALSE;
          glutIdleFunc(NULL);
        }
        else 
        {
          G_spinning = TRUE;
          glutIdleFunc(animate);
        }
      }
      else if (G_mode==TRANSLATE)
        glutIdleFunc(NULL);
    }
  }
}


void zoom(void)
{
  float distance, sign, dotproduct, motionvector[2];
  motionvector[0] = G_currx-G_startx;
  motionvector[1] = G_curry-G_starty;
  dotproduct = G_zoomvector[0]*motionvector[0] + G_zoomvector[1]*motionvector[1];
  if (dotproduct<0)
    sign = -1;
  else
    sign = 1;  
  distance = sqrt(motionvector[0]*motionvector[0] + motionvector[1]*motionvector[1]);
  G_scale = G_oldscale * (1.0 + sign*(distance/MAX(G_halfW,G_halfH)));
  glutPostRedisplay();
}


void pan(void)
{
  G_pan[0] += (float)(G_currx - G_lastx)/G_W;
  G_pan[1] += (float)(G_lasty - G_curry)/G_H;
  G_lastx = G_currx;
  G_lasty = G_curry;
  glutPostRedisplay();
}


/* very similar to zoom() */
void fov(void)
{
  float distance, sign, dotproduct, motionvector[2];
  motionvector[0] = G_currx-G_startx;
  motionvector[1] = G_curry-G_starty;
  dotproduct = G_zoomvector[0]*motionvector[0] + G_zoomvector[1]*motionvector[1];
  if (dotproduct<0)
    sign = -1;
  else
    sign = 1;  
  distance = sqrt(motionvector[0]*motionvector[0] + motionvector[1]*motionvector[1]);
  G_fov = G_oldfov * (1.0 + sign*(distance/MAX(G_halfW,G_halfH)));
  if (G_fov<1.0)
    G_fov = 1.0;
  if (G_fov>180.0)
    G_fov = 180.0;
  glMatrixMode(GL_PROJECTION);
  glPopMatrix(); /* clear stack */
  glLoadIdentity();
  gluPerspective( /* field of view in degree */ G_fov,
  		  /* aspect ratio */ 1.0,
                  /* Z near */ 1.0,  /* Z far */ 1000.0);
  glPushMatrix(); /* save a copy in stack */
  glMatrixMode(GL_MODELVIEW);
  glutPostRedisplay();
}


void motion(int x, int y)
{
  if (G_dragging) 
    if (G_mode==ROTATE)
    {
      trackball(G_lastquat,
                2.0 * (G_W - x) / G_W - 1.0,
                2.0 * y / G_H - 1.0,
                2.0 * (G_W - G_currx) / G_W - 1.0,
                2.0 * G_curry / G_H - 1.0);
      G_currx = x;
      G_curry = y;
   /* G_spinning = TRUE; */
   /* glutIdleFunc(animate); */
      animate();
    }
    else if (G_mode==ZOOM)
    {
      G_currx = x;
      G_curry = y;
      glutIdleFunc(zoom);
    }
    else if (G_mode==FOV)
    {
      G_currx = x;
      G_curry = y;
      glutIdleFunc(fov);
    }
    else if (G_mode==TRANSLATE)
    {
      G_currx = x;
      G_curry = y;
      glutIdleFunc(pan);
    }
}


void reshape(int width, int height)
{
  G_W = width;
  G_H = height;
  G_halfW = G_W/2;
  G_halfH = G_H/2;
  glViewport(0,0,width,height);
}



/* 
 * Save framebuffer as an image in pbm format 
 */
void SaveRGBImage(char *filename)
{
  unsigned char *buffer;
  int w, h;
  FILE *fptr;
  GLint viewport[4];
  
  glGetIntegerv(GL_VIEWPORT, viewport);  
  fprintf(stderr, "%d %d %d %d\n", viewport[0], viewport[1], viewport[2], viewport[3]);
  fprintf(stderr, "%d %d\n", G_W, G_H);
  w = G_W;
  h = G_H;
  if ((buffer=(unsigned char*)malloc(3*w*h))==NULL)
    ERREXIT("[SaveRGBImage]: not enough memory for saving image\n");
  if ((fptr=fopen(filename,"wb"))==NULL)
    ERREXIT("[SaveRGBImage]: cannot write image file\n");
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, buffer);
  fprintf(fptr, "P6\n%d %d\n255\n", w, h);
  cp_fwrite(buffer, 1, w*h*3, fptr);
  fclose(fptr);
  free(buffer);
}



void controlMenu(int value)
{
  int oldmenu;
  oldmenu = glutGetMenu();
  glutSetMenu(G_rightbuttonmenu);
  switch (value) 
  {
    case 1:
      G_lightZeroSwitch = !G_lightZeroSwitch;
      if (G_lightZeroSwitch) 
      {
        glutChangeToMenuEntry(value, "Turn off right light", value);
        glEnable(GL_LIGHT0);
      }
      else 
      {
        glutChangeToMenuEntry(value, "Turn on right light", value);
        glDisable(GL_LIGHT0);
      }
      break;
    case 2:
      G_lightOneSwitch = !G_lightOneSwitch;
      if (G_lightOneSwitch) 
      {
        glutChangeToMenuEntry(value, "Turn off left light", value);      
        glEnable(GL_LIGHT1);
      }
      else 
      {
        glutChangeToMenuEntry(value, "Turn on left light", value);      
        glDisable(GL_LIGHT1);
      }
      break;
    case 3:
      G_smoothshade = !G_smoothshade;
      if (G_smoothshade)
      {
        glutChangeToMenuEntry(value, "Flat shading", value);
        glShadeModel(GL_SMOOTH);
      }
      else
      {
        glutChangeToMenuEntry(value, "Smooth shading", value);
        glShadeModel(GL_FLAT);
      }
      break;
    case 4: 
/*      G_flipnormal = !G_flipnormal; */
      G_allflip = !G_allflip;
      glDeleteLists(G_NormalObj,1);
      glDeleteLists(G_Wireframe, 1);
      glDeleteLists(G_BoxObj, 1);
      InitModel(G_filename, G_filetype);
      break;
    case 5:
      G_cullface = !G_cullface;
      if (G_cullface)
      {
        glutChangeToMenuEntry(value, "Turn off backface culling", value);        
        glEnable(GL_CULL_FACE);
      }
      else 
      {
        glutChangeToMenuEntry(value, "Turn on backface culling", value);
        glDisable(GL_CULL_FACE);
      }
      break;
    case 6:
      G_mode = (G_mode+1)%4;
      switch (G_mode)
      {
        case ZOOM:
          glutChangeToMenuEntry(value, "Now: Zoom mode", value);
          break;
        case ROTATE:
          glutChangeToMenuEntry(value, "Now: Rotate mode", value);
          break;
        case TRANSLATE:
          glutChangeToMenuEntry(value, "Now: Pan mode", value);
          break;
        case FOV:
          glutChangeToMenuEntry(value, "Now: FOV mode", value);
          break;
      }
      break;
    case 7:
      G_recordtransform=TRUE;
      break;
    case 8:
      SaveRGBImage("rgbimg.ppm");
      break;
    case 9:
      G_drawwireframe = !G_drawwireframe;
      if (G_drawwireframe)
	glutChangeToMenuEntry(value, "Don't draw wireframe", value);        
      else 
        glutChangeToMenuEntry(value, "Draw wireframe", value);
      break;
    case 10: 
      glDeleteLists(G_NormalObj,1);
      glDeleteLists(G_Wireframe, 1);
      glDeleteLists(G_BoxObj, 1);
      InitModel(G_filename, G_filetype);
      break;
    case 11:
      G_EnableEScale = !G_EnableEScale;
      break;
  }
  glutPostRedisplay();
  glutSetMenu(oldmenu);
}


void vis(int visible)
{
  if (visible == GLUT_VISIBLE) 
  {
    if (G_spinning)
      glutIdleFunc(animate);
  } 
  else 
  {
    if (G_spinning)
      glutIdleFunc(NULL);
  }
}


void InitRenderer()
{
  glEnable(GL_CULL_FACE);
  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LESS);
  glEnable(GL_LIGHTING);
  glMatrixMode(GL_PROJECTION);
  gluPerspective( /* field of view in degree */ G_fov,  
  		  /* aspect ratio */ 1.0,
                  /* Z near */ 1.0,  /* Z far */ 1000.0);
  glPushMatrix(); /* save a copy in stack */
  glMatrixMode(GL_MODELVIEW);
  gluLookAt(0.0, 0.0, 30.0,  /* eye is at (0,0,30) */
    0.0, 0.0, 0.0,      /* center is at (0,0,0) */
    0.0, 1.0, 0.0);      /* up is in postivie Y direction */
  glPushMatrix();       /* dummy push so we can pop on model
                           recalc */
  glLightModeli(GL_LIGHT_MODEL_LOCAL_VIEWER, 1);
  glLightfv(GL_LIGHT0, GL_POSITION, G_lightZeroPosition);
  glLightfv(GL_LIGHT0, GL_DIFFUSE, G_lightZeroColor);
  glLightf(GL_LIGHT0, GL_CONSTANT_ATTENUATION, 0.1);
  glLightf(GL_LIGHT0, GL_LINEAR_ATTENUATION, 0.05);
  glLightfv(GL_LIGHT1, GL_POSITION, G_lightOnePosition);
  glLightfv(GL_LIGHT1, GL_DIFFUSE, G_lightOneColor);
  glEnable(GL_LIGHT0);
  glEnable(GL_LIGHT1);
  glLineWidth(2.0);
  glFrontFace (GL_CW);
  glEnable(GL_AUTO_NORMAL); 
  glEnable(GL_NORMALIZE); 
                  
  trackball(G_curquat, 0.0, 0.0, 0.0, 0.0);  /* init current quaterion */
}


void main(int argc, char **argv)
{
  int argidx;
  char title[1024];
  
  glutInit(&argc, argv);  /* let glut extract its own argument */
  
  /* Read the argument */
  fprintf(stderr, "Usage:\n");
  fprintf(stderr, "  -ib <file>  input Triangle binary\n");
  fprintf(stderr, "  -iB <file>  input triangle binary (with header)\n");
  fprintf(stderr, "  -ir <file>  input Rib\n");
  fprintf(stderr, "  -it <file>  input TPoly\n");
  fprintf(stderr, "  -f          flip the normal of input triangles\n");
  fprintf(stderr, "  -x <scale>  explicity scale x\n");
  fprintf(stderr, "  -y <scale>  explicity scale y\n");
  fprintf(stderr, "  -z <scale>  explicity scale z\n");

  for (argidx=1 ; argidx<argc ; argidx++)
    if (argv[argidx][0] == '-')
    {
      switch(argv[argidx][1])
      {
        case 'i':
          if (argv[argidx][2]=='t')
          {
	    G_filetype = TPOLY;
            argidx++;
            if (argidx>=argc)
            {
              fprintf(stderr, "[main]: no filename specified\n");
              exit(1);
            }
            strcpy (G_filename, argv[argidx]);
          }
          else if (argv[argidx][2]=='r')
          {
	    G_filetype = RENDERMAN;
            argidx++;
            if (argidx>=argc)
            {
              fprintf(stderr, "[main]: no filename specified\n");
              exit(1);
            }
            strcpy (G_filename, argv[argidx]);
          }
	  else if (argv[argidx][2]=='b')
	  {
	    fprintf(stderr, "Triangle Binary file may not be read correctly if run on different machine\n");
	    G_filetype = TRIBINARY;
	    argidx++;
	    if (argidx>=argc)
            {
              fprintf(stderr, "[main]: no filename specified\n");
              exit(1);
            }
            strcpy (G_filename, argv[argidx]);
          }
          else if (argv[argidx][2]=='B')
          {
            fprintf(stderr, "Triangle Binary2 file may not be read correctly if run on different machine\n");
	    G_filetype = TRIBINARY2;
	    argidx++;
	    if (argidx>=argc)
            {
              fprintf(stderr, "[main]: no filename specified\n");
              exit(1);
            }
            strcpy (G_filename, argv[argidx]);
          }
	  break;
	  
	case 'f':
	  G_allflip = TRUE;
	  break;
	  
	case 'x':
	  argidx++;
	  G_EXScale = atof(argv[argidx]);
	  break;

	case 'y':
	  argidx++;
	  G_EYScale = atof(argv[argidx]);
	  break;

	case 'z':
	  argidx++;
	  G_EZScale = atof(argv[argidx]);
	  break;
      }
    }
  
  glutInitDisplayMode(GLUT_RGB | GLUT_DOUBLE | GLUT_DEPTH);
  sprintf(title, "viewtri - %s", G_filename);
  glutCreateWindow(title);
  glutDisplayFunc(redraw);
  glutVisibilityFunc(vis);
  glutMouseFunc(mouse);
  glutMotionFunc(motion);
  glutReshapeFunc(reshape);

  G_rightbuttonmenu = glutCreateMenu(controlMenu);
  glutAddMenuEntry("Turn off right light", 1);
  glutAddMenuEntry("Turn off left light", 2);
  glutAddMenuEntry("Flat shading", 3);
  glutAddMenuEntry("Flip normal", 4);
  glutAddMenuEntry("Turn off backface culling", 5);
  glutAddMenuEntry("Now: Rotate mode", 6);
  glutAddMenuEntry("Record transform matrix", 7);
  glutAddMenuEntry("Save current image", 8);
  glutAddMenuEntry("Draw wireframe", 9);
  glutAddMenuEntry("Reload Data", 10);
  glutAddMenuEntry("Disable Explicit Scale", 11);
  glutAttachMenu(GLUT_RIGHT_BUTTON);
  

  G_pan[0] = G_pan[1] = 0;
  G_smoothshade = InitModel(G_filename, G_filetype);
  InitRenderer();
  glutMainLoop();
}

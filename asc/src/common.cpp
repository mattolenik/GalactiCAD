//
// common.cpp
//
// A module with various small utility functions defined
//
//
// Copyright (c) Tien-Tsin Wong, 1996-2001
// All rights reserved.
//
//
#include <stdio.h>
#include <stdlib.h>
#include <memory.h>
#include <math.h>
#include "common.h"
#ifdef WIN32
#include "pcvalues.h"
#include <sys/timeb.h>
#else
#include <sys/resource.h>
#include <unistd.h>
#include <values.h>
#endif


// Prototypes of local functions
int FtCompare(const void *arg1, const void *arg2);



// This function ensures the data order is increasing i.e.
// interval[0] < interval[1]
void SpanReorder(int *interval)
{
  int tmp;
  // make sure the data order in xwin & ywin are alright.
  tmp = MAX(interval[0], interval[1]);
  interval[0] = MIN(interval[0], interval[1]);
  interval[1] = tmp;
}


// Calculate the intersection region of two input windows.
// Note that if there is no intersection, xout[0] > xout[1] and/or
// yout[0] > yout[1]
void WindowIntersect(int *xwin1, int *ywin1, int *xwin2, 
		     int *ywin2, int *xout,  int *yout)
{
  xout[0] = MAX(xwin1[0], xwin2[0]); // intersection left is MAX of the left ends of both spans.
  xout[1] = MIN(xwin1[1], xwin2[1]); // intersection right is MIN of the right ends of both spans.
  yout[0] = MAX(ywin1[0], ywin2[0]);
  yout[1] = MIN(ywin1[1], ywin2[1]);
}



//
// SingleSwapByte
// Swap the byte order of a single element which may contain nbytes of bytes 
// Same as SwapByte(), except that it does only one element rather than
// array of elements in SwapByte()
//
// INPUT:
//   buf       buffer holding the element with (nbytes) bytes
//   nbytes    size of this element
//
// RESULT:
//   The content in buf[] is switched from Big Endian to Small Endian
//   or Small Endian to Big Endian.
//
void SingleSwapByte(unsigned char *buf, int nbytes)
{
  int head, end;
  unsigned char tmp;
  for (head=0, end=nbytes-1 ; head < end ; head++, end--)
  {
    tmp = buf[head];
    buf[head] = buf[end];
    buf[end] = tmp;
  }
}



//
// SwapByte 
// Swap an array of nelem data (each with size of "size") 
// It is designed to solve the byte order inconsistency in SGI, SUN 
// and PC. 
//
// INPUT:
//   buf       Buffer holding the (nelem) element array
//   elemsize  Byte size of each element
//   nelem     No of element in the array
// 
// RESULT:
//   Each element in the array is changed from big to small endian
//   or small to big endian.
//
void SwapByte(unsigned char *buf, size_t elemsize, size_t nelem)
{
  size_t head, end, elem;
  unsigned char tmp;

  for(elem=0 ; elem < nelem ; elem++)
  {
    for(head=0, end=elemsize-1 ; head < end ; head++, end--)
    {
      tmp = buf[head];
      buf[head] = buf[end];
      buf[end] = tmp;
    }
    buf += elemsize;
  }
}



// Cross platform fread
// This routine is used to replace fread(). In PC, this routine will
// automatically swap the byte order after reading the data. In UNIX, 
// this routine is equivalent to fread().
// This routine decides how to swap the data by looking the argument
// "size". This argument tells the size of the basic element. 
// If size=1, no swapping is done. Otherwise, swapping is done.
// If the user doesn't want his data to be automatically byte-swapped
// he should set the "size" argument to 1
size_t cp_fread(void *buf, size_t size, size_t n, FILE* file)
{
#ifdef WIN32

  if (size == 1)
    return fread(buf, size, n, file);
  else if (size < 1)
    ERREXIT("[cp_fread]: fread size < 1\n");

  size_t result = fread(buf, size, n, file);
  // swap byte order automatically
  SwapByte((unsigned char *)buf, size, result); 
  return result;

#else
  return fread(buf, size, n, file);
#endif
}



// Cross platform fwrite
// This routine is used to replace fwrite(). In PC, this routine will
// automatically swap the byte order before writing the data. In UNIX, 
// this routine is equivalent to fread(). After writing, the data
// is swapped back to restore to the original byte order. Note this 
// may introduce error, if the given data has out-of-bound problem.
// This routine decides how to swap the data by looking the argument
// "size". This argument tells the size of the basic element. 
// If size=1, no swapping is done. Otherwise, swapping is done.
// If the user doesn't want his data to be automatically byte-swapped
// he should set the "size" argument to 1
// In other words, it always write data in UNIX binary format
size_t cp_fwrite(void *buf, size_t size, size_t n, FILE* file)
{
#ifdef WIN32

  if (size == 1)
    return fwrite(buf, size, n, file);
  else if (size < 1)
    ERREXIT("[cp_fwrite]: fwrite size < 1\n");

  // swap byte order automatically for writing
  SwapByte((unsigned char *)buf, size, n); 
  int result = fwrite(buf, size, n, file);
  // swap byte order back to original byte order
  SwapByte((unsigned char *)buf, size, n); 
  return result;

#else
  return fwrite(buf, size, n, file);
#endif
}




// This function is the complete reversed version of cp_fwrite.
// Instead of always writing unix binary data, it always output
// PC binary data.
size_t pc_fwrite(void *buf, size_t size, size_t n, FILE* file)
{
#ifndef WIN32

  if (size == 1)
    return fwrite(buf, size, n, file);
  else if (size < 1)
    ERREXIT("[cp_fwrite]: fwrite size < 1\n");

  // swap byte order automatically for writing
  SwapByte((unsigned char *)buf, size, n); 
  int result = fwrite(buf, size, n, file);
  // swap byte order back to original byte order
  SwapByte((unsigned char *)buf, size, n); 
  return result;

#else
  return fwrite(buf, size, n, file);
#endif
}



// This routine is just like pc_fwrite, is the reversed version
// of cp_fread. It always assume the binary data is in PC byte order.
size_t pc_fread(void *buf, size_t size, size_t n, FILE* file)
{
#ifndef WIN32

  if (size == 1)
    return fread(buf, size, n, file);
  else if (size < 1)
    ERREXIT("[cp_fread]: fread size < 1\n");

  int result = fread(buf, size, n, file);
  // swap byte order automatically
  SwapByte((unsigned char *)buf, size, result); 
  return result;

#else
  return fread(buf, size, n, file);
#endif
}




// 
// GetFileSize
//
// It is really frustrated that there no generic C function call
// that tells you the file size of an interested file.
// This function gets the file size of the binary file pointed by fptr.
// This function is not suitable for text file because of two reasons:
// 1. Text mode causes carriage return-linefeed translation;
// 2. Ctrl-Z will be interpreted as end of file.
// Return -1 if error occurs.
// 
// INPUT:
//   fptr     The file pointer
// 
// OUTPUT:
//   <return> Returns the file size in long type.
// 
long GetFileSize(FILE *fptr)
{
  long currpos, filesize;

  currpos = ftell(fptr);	// backup the current position

  if (fseek(fptr, 0, SEEK_END))
    return -1;
  filesize = ftell(fptr);

  if (fseek(fptr, currpos, SEEK_SET))	// reset the current position; disaster if fail
    return -1;

  return filesize;
}



//
// InvertBuf()
//
// Given a buffer with 'h' scanlines and each scanline requires 'scansize'
// bytes. The following function flip the buffer vertically.
//
// INPUT
//   h          # of scanlines
//   scansize   # of bytes allocated for each scanline
//   buf        Buffer to flip vertically
//   
// OUTPUT
//   buf        Buffer flipped
//
void InvertBuf(unsigned char *buf, int h, long scansize)
{
  unsigned char *scanline;
  int  a, b;
  long linesize = scansize;
  long a_pos, b_pos;

  if ((scanline=(unsigned char *)malloc(linesize))==NULL)
    ERREXIT("[InvertBuf]:No memory for scanline\n");

  for (a=0, b=h-1 ; a < b ; a++, b--)
  { // Swap the two scanlines.
    a_pos = a * linesize;
    b_pos = b * linesize;
    memcpy(scanline,      &(buf[a_pos]), linesize);
    memcpy(&(buf[a_pos]), &(buf[b_pos]), linesize);
    memcpy(&(buf[b_pos]), scanline,      linesize);
  }
  free(scanline);
}



//
// FtMapStat()
//
// It treats the buffer as an array of numerical values (float)
// and then calculates some statistics including, mean, median,
// min, max, sd. 
//
// INPUT:
//   w, h      Width and height of the 2D buffer
//   buf       Buffer holding the numerical values
//   statflag  Array of char flag indicating which statistics metrix
//             is needed, refer those STAT_*  macros for flags
//
// OUTPUT:
//   <return>  Array of floating where the statistics are written to.
//             The position of mean, median, max and min, ... are
//             located in the same order as statflag. Hence use
//             stat[STAT_*] to retrieve the data
//             Caller is NOT allowed to free the returned array pointer
//
float *FtMapStat(int w, int h, float *buf, char *statflag)
{
  int    i, size;
  float *elemptr;
  float  mean, minv, maxv, acc;
  static float stat[STAT_PROP_NO];

  size = w*h;
  for (i=0 ; i<STAT_PROP_NO ; i++)
    stat[i] = 0;

  //first pass: find the mean, min, max, 
  acc = 0;
  maxv = -MAXFLOAT;
  minv =  MAXFLOAT;
  for (elemptr=buf, i=0 ; i<size ; elemptr++, i++)  
  {
    acc += *elemptr;
    if (statflag[STAT_MIN] && minv > *elemptr)
      minv = *elemptr;
    if (statflag[STAT_MAX] && maxv < *elemptr)
      maxv = *elemptr;
  }
  stat[STAT_MEAN] = mean = acc / size;
  stat[STAT_MIN]  = minv;
  stat[STAT_MAX]  = maxv;

  if (statflag[STAT_VAR] || statflag[STAT_SD])
  { 
    acc = 0;
    for (elemptr=buf, i=0 ; i<size ; elemptr++, i++)  //sec pass: find variance
      acc += (*elemptr - mean)*(*elemptr - mean);
    acc /= size;
    stat[STAT_VAR] = acc;
    stat[STAT_SD]  = (float)sqrt(acc);
  }

  if (statflag[STAT_MEDIAN])
  {
    float *buf2;

    if ((buf2=(float*)malloc(sizeof(float)*size))==NULL)
      ERREXIT("[FtMapStat]: No memory for buf2\n");
    memcpy(buf2, buf, size*sizeof(float));
    
    // sort buf2 
    qsort((void*)buf2, size, sizeof(float), FtCompare);
    stat[STAT_MEDIAN] = buf2[size/2];

    free(buf2);
  }

  return stat;
}



//
// FtCompare()
//
// Accessory function of FtMapStat(). It is in the qsort's compare
// format. It simply compares two floats
//
// INPUT:
//   arg1, arg2,  two floats to compare
//
// OUTPUT:
//   return -ve if arg1 <  arg2 
//   return 0   if arg1 == arg2
//   return +ve if arg1 >  arg2
//
int FtCompare(const void *arg1, const void *arg2)
{
  float result;
  result = (*((float*)arg1) - *((float*)arg2));
  if (result < 0)
    return -1;
  if (result > 0)
    return 1;
  return 0;
}


//
// CurrentTime()
//
// Get the current time (work on both UNIX and 
// Windows platforms)
//
// OUTPUT:
//   <RETURN>   Return the current time in unit of second. 
//              Double precision.
//
double CurrTime()
{
  #ifdef WIN32

    struct _timeb timebuffer;
    _ftime( &timebuffer );
    return ( (double) timebuffer.time + (double) timebuffer.millitm * 1e-3 );

  #else

    struct rusage currTime;
    getrusage(0,&currTime);
    return ( (double) (currTime.ru_utime.tv_sec + currTime.ru_utime.tv_usec*1e-6) );

  #endif
}

